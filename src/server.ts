#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadPrivateKey, loadReviewConfig, positiveInteger } from "./config.ts";
import { errorMessage } from "./errors.ts";
import { GitHubClient, InstallationTokenProvider } from "./github.ts";
import { prepareAcceptedJob } from "./progress.ts";
import { SerialDedupeQueue } from "./queue.ts";
import { reviewPullRequest } from "./reviewer.ts";
import type {
  AppClient,
  EnvSource,
  Logger,
  ReviewConfig,
  ReviewJob,
  TokenProvider,
} from "./types.ts";
import { reviewJobFromWebhook, verifyWebhookSignature } from "./webhook.ts";

const maxBodyBytes = 2 * 1024 * 1024;

export interface AppServerOptions {
  webhookSecret: string | undefined;
  tokenProvider: TokenProvider;
  reviewConfig: ReviewConfig;
  logger?: Logger;
  createClient?: (token: string) => AppClient;
}

export function createAppServer({
  webhookSecret,
  tokenProvider,
  reviewConfig,
  logger = console,
  createClient = (token) => new GitHubClient(token, globalThis.fetch, reviewConfig.botLogin),
}: AppServerOptions) {
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");

  const queue = new SerialDedupeQueue<ReviewJob>(
    async (job) => {
      const token = await tokenProvider.get(job.installationId);
      const client = createClient(token);
      const prepared = await prepareAcceptedJob(
        client,
        job,
        {
          author: reviewConfig.author,
          fingerprint: reviewConfig.fingerprint,
          force: Boolean(job.force),
          botLogin: reviewConfig.botLogin,
        },
        logger,
      );
      if (!prepared) return;
      await reviewPullRequest({
        client,
        fullName: prepared.fullName,
        number: prepared.number,
        config: reviewConfig,
        force: Boolean(job.force),
        checkRunId: prepared.checkRunId,
        eyesReactionId: prepared.eyesReactionId,
        logger,
      });
    },
    {
      onError: (error, job) => logger.error(`Review failed for ${job.key}: ${errorMessage(error)}`),
    },
  );

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return json(response, 200, { ok: true, queued: queue.size });
      }
      if (request.method !== "POST" || request.url !== "/github/webhook") {
        return json(response, 404, { error: "not_found" });
      }

      const body = await readBody(request, maxBodyBytes);
      if (!verifyWebhookSignature(webhookSecret, body, request.headers["x-hub-signature-256"])) {
        return json(response, 401, { error: "invalid_signature" });
      }

      const eventName = headerValue(request.headers["x-github-event"]);
      if (eventName === "ping") return json(response, 200, { ok: true });

      let payload: unknown;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return json(response, 400, { error: "invalid_json" });
      }

      const job = reviewJobFromWebhook(eventName, payload, reviewConfig.author);
      if (!job) return json(response, 202, { accepted: false });
      queue.enqueue(job);
      logger.log(`Queued ${job.key} at ${job.headSha?.slice(0, 7) || "unknown"}`);
      return json(response, 202, { accepted: true });
    } catch (error) {
      if (error instanceof BodyTooLargeError)
        return json(response, 413, { error: "body_too_large" });
      logger.error(`Webhook request failed: ${errorMessage(error)}`);
      return json(response, 500, { error: "internal_error" });
    }
  });

  return { server, queue };
}

export async function startFromEnvironment(env: EnvSource = process.env, logger: Logger = console) {
  const reviewConfig = loadReviewConfig(env);
  const tokenProvider = new InstallationTokenProvider({
    clientId: env.APP_CLIENT_ID || env.APP_ID,
    privateKey: loadPrivateKey(env),
  });
  const { server, queue } = createAppServer({
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    tokenProvider,
    reviewConfig,
    logger,
  });
  const port = positiveInteger(env.PORT, 3000);
  const host = env.HOST || "0.0.0.0";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  logger.log(`hedgehog-pr-bot listening on ${host}:${port}`);

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received; draining reviews`);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await queue.onIdle();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
  process.once("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  return { server, queue };
}

function headerValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      length += chunk.length;
      if (length > limit) {
        settled = true;
        reject(new BodyTooLargeError("Request body is too large"));
      } else {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

class BodyTooLargeError extends Error {
  code = "BODY_TOO_LARGE";
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
