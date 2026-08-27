#!/usr/bin/env node

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadPrivateKey, loadReviewConfig, positiveInteger } from "./config.mjs";
import { GitHubClient, InstallationTokenProvider } from "./github.mjs";
import { cancelQueuedProgress, prepareAcceptedJob } from "./progress.mjs";
import { SerialDedupeQueue } from "./queue.mjs";
import { reviewPullRequest } from "./reviewer.mjs";
import { reviewJobFromWebhook, verifyWebhookSignature } from "./webhook.mjs";

const maxBodyBytes = 2 * 1024 * 1024;

export function createAppServer({
  webhookSecret,
  tokenProvider,
  reviewConfig,
  logger = console,
  createClient = (token) => new GitHubClient(token),
}) {
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");

  const queue = new SerialDedupeQueue(async (job) => {
    const token = await tokenProvider.get(job.installationId);
    const client = createClient(token);
    await reviewPullRequest({
      client,
      fullName: job.fullName,
      number: job.number,
      config: reviewConfig,
      force: Boolean(job.force),
      checkRunId: job.checkRunId,
      eyesReactionId: job.eyesReactionId,
      logger,
    });
  }, {
    onError: (error, job) => logger.error(`Review failed for ${job.key}: ${error.message}`),
    onReplace: (previous) => {
      tokenProvider.get(previous.installationId).then((token) => (
        cancelQueuedProgress(createClient(token), {
          fullName: previous.fullName,
          checkRunId: previous.checkRunId,
          logger,
        })
      )).catch((error) => logger.error(`Could not cancel superseded check for ${previous.key}: ${error.message}`));
    },
  });

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

      const eventName = request.headers["x-github-event"];
      if (eventName === "ping") return json(response, 200, { ok: true });

      let payload;
      try {
        payload = JSON.parse(body.toString("utf8"));
      } catch {
        return json(response, 400, { error: "invalid_json" });
      }

      const job = reviewJobFromWebhook(eventName, payload, reviewConfig.author);
      if (!job) return json(response, 202, { accepted: false });
      try {
        const token = await tokenProvider.get(job.installationId);
        const prepared = await prepareAcceptedJob(createClient(token), job, reviewConfig.author, logger);
        if (!prepared) return json(response, 202, { accepted: false });
        queue.enqueue(prepared);
        logger.log(`Queued ${prepared.key} at ${prepared.headSha?.slice(0, 7) || "unknown"}`);
        return json(response, 202, { accepted: true });
      } catch (error) {
        logger.error(`Could not start progress for ${job.key}: ${error.message}`);
        queue.enqueue(job);
        logger.log(`Queued ${job.key} at ${job.headSha?.slice(0, 7) || "unknown"}`);
        return json(response, 202, { accepted: true });
      }
    } catch (error) {
      if (error.code === "BODY_TOO_LARGE") return json(response, 413, { error: "body_too_large" });
      logger.error(`Webhook request failed: ${error.message}`);
      return json(response, 500, { error: "internal_error" });
    }
  });

  return { server, queue };
}

export async function startFromEnvironment(env = process.env, logger = console) {
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
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  logger.log(`greg-pr-bot listening on ${host}:${port}`);

  const shutdown = async (signal) => {
    logger.log(`${signal} received; draining reviews`);
    await new Promise((resolve) => server.close(resolve));
    await queue.onIdle();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM").then(() => process.exit(0)));
  process.once("SIGINT", () => shutdown("SIGINT").then(() => process.exit(0)));
  return { server, queue };
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    request.on("data", (chunk) => {
      if (settled) return;
      length += chunk.length;
      if (length > limit) {
        settled = true;
        const error = new Error("Request body is too large");
        error.code = "BODY_TOO_LARGE";
        reject(error);
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

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromEnvironment().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
