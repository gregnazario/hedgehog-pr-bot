#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { loadPrivateKey, loadReviewConfig, positiveInteger } from "./config.ts";
import { Dashboard } from "./dashboard.ts";
import { errorMessage } from "./errors.ts";
import { GitHubClient, InstallationTokenProvider } from "./github.ts";
import { applyIgnoreJob } from "./ignore.ts";
import { makeJsonLogger } from "./logging.ts";
import { loadIgnoreMemory } from "./memory.ts";
import { createMetrics, type Metrics } from "./metrics.ts";
import { notifyReview, severityCounts } from "./notify.ts";
import { cancelQueuedProgress, prepareAcceptedJob, startQueuedProgress } from "./progress.ts";
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
  metrics?: Metrics;
  dashboardToken?: string;
  createClient?: (token: string) => AppClient;
}

export function createAppServer({
  webhookSecret,
  tokenProvider,
  reviewConfig,
  logger = console,
  metrics = createMetrics(),
  dashboardToken,
  createClient = (token) => new GitHubClient(token, globalThis.fetch, reviewConfig.botLogin),
}: AppServerOptions) {
  if (!webhookSecret) throw new Error("GITHUB_WEBHOOK_SECRET is required");
  const dashboard = new Dashboard(
    dashboardToken ?? (reviewConfig as { dashboardToken?: string }).dashboardToken,
  );

  const queue = new SerialDedupeQueue<ReviewJob>(
    async (job) => {
      const token = await tokenProvider.get(job.installationId);
      const client = createClient(token);
      if (job.kind === "ignore") {
        metrics.inc("ignore_jobs_total");
        await applyIgnoreJob(
          client,
          job,
          { botLogin: reviewConfig.botLogin, memoryPath: reviewConfig.memoryPath ?? "" },
          logger,
        );
        return;
      }
      const startedAt = Date.now();
      const prepared = await prepareAcceptedJob(
        client,
        job,
        {
          author: reviewConfig.authors,
          fingerprint: reviewConfig.fingerprint,
          force: Boolean(job.force),
          botLogin: reviewConfig.botLogin,
        },
        logger,
      );
      if (!prepared) {
        metrics.inc("job_results_total", { result: "skipped" });
        dashboard.recordJob({
          at: new Date().toISOString(),
          repository: job.fullName,
          number: job.number,
          head: job.headSha ?? "",
          status: "skipped",
          severities: {},
          durationMs: Date.now() - startedAt,
        });
        return;
      }
      const ignoredFingerprints = await loadIgnoreMemory(reviewConfig.memoryPath ?? "");
      const result = await reviewPullRequest({
        client,
        fullName: prepared.fullName,
        number: prepared.number,
        config: reviewConfig,
        force: Boolean(job.force),
        checkRunId: prepared.checkRunId,
        eyesReactionId: prepared.eyesReactionId,
        repoConfig: prepared.repoConfig,
        ignoredFingerprints,
        logger,
      });
      metrics.inc("job_results_total", { result: result.status });
      dashboard.recordJob({
        at: new Date().toISOString(),
        repository: job.fullName,
        number: job.number,
        head: prepared.headSha ?? job.headSha ?? "",
        status: result.status,
        event: result.status === "reviewed" ? result.event : undefined,
        severities: severityCounts(result.status === "reviewed" ? result.severities : []),
        durationMs: Date.now() - startedAt,
      });
      if (reviewConfig.notifyWebhook) {
        notifyReview(reviewConfig.notifyWebhook, {
          type: "review",
          repository: job.fullName,
          pull_request: job.number,
          head: prepared.headSha ?? job.headSha ?? "",
          status: result.status,
          event: result.status === "reviewed" ? result.event : undefined,
          severities: severityCounts(result.status === "reviewed" ? result.severities : []),
        }).then((delivered) => {
          if (!delivered) logger.error(`Could not deliver review notification for ${job.key}`);
        });
      }
    },
    {
      onError: (error, job) => logger.error(`Review failed for ${job.key}: ${errorMessage(error)}`),
      onReplace: (previous) => {
        tokenProvider
          .get(previous.installationId)
          .then((token) =>
            cancelQueuedProgress(createClient(token), {
              fullName: previous.fullName,
              checkRunId: previous.checkRunId,
              logger,
            }),
          )
          .catch((error) =>
            logger.error(
              `Could not cancel superseded check for ${previous.key}: ${errorMessage(error)}`,
            ),
          );
      },
    },
  );

  // Runs in the webhook request: one round trip for the queued check (well
  // under GitHub's delivery timeout) so the PR shows queueing immediately and
  // a replacement can cancel it. The /review ack is fire-and-forget.
  const acceptJob = async (job: ReviewJob) => {
    if (job.triggerCommentId) {
      const commentId = job.triggerCommentId;
      tokenProvider
        .get(job.installationId)
        .then((token) => createClient(token).reactToIssueComment?.(job.fullName, commentId, "eyes"))
        .catch((error) => logger.error(`Could not acknowledge /review: ${errorMessage(error)}`));
    }
    if (job.headSha) {
      try {
        const token = await tokenProvider.get(job.installationId);
        job.checkRunId = await startQueuedProgress(createClient(token), {
          fullName: job.fullName,
          headSha: job.headSha,
          logger,
        });
      } catch (error) {
        logger.error(`Could not open queued check for ${job.key}: ${errorMessage(error)}`);
      }
    }
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        return json(response, 200, { ok: true, queued: queue.size });
      }
      if (
        request.method === "GET" &&
        (request.url?.split("?")[0] === "/dashboard" ||
          request.url?.split("?")[0] === "/dashboard.json")
      ) {
        if (
          !dashboard.authorized({
            url: request.url,
            headers: { authorization: request.headers.authorization },
          })
        ) {
          return json(response, 404, { error: "not_found" });
        }
        const wantsJson = request.url?.startsWith("/dashboard.json");
        const metricsText = `${metrics.render()}# TYPE queue_depth gauge\nqueue_depth ${queue.size}\n`;
        if (wantsJson)
          return json(response, 200, JSON.parse(dashboard.renderJson(queue.size, metricsText)));
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(dashboard.renderHtml(queue.size, metricsText));
        return;
      }
      if (request.method === "GET" && request.url === "/metrics") {
        response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
        response.end(`${metrics.render()}# TYPE queue_depth gauge\nqueue_depth ${queue.size}\n`);
        return;
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

      metrics.inc("webhook_events_total", { event: eventName ?? "unknown" });
      const job = reviewJobFromWebhook(eventName, payload, reviewConfig.authors);
      if (!job) {
        metrics.inc("webhook_rejected_total");
        return json(response, 202, { accepted: false });
      }
      metrics.inc("webhook_accepted_total");
      await acceptJob(job);
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

export async function startFromEnvironment(
  env: EnvSource = process.env,
  logger: Logger = env.LOG_FORMAT === "json" ? makeJsonLogger() : console,
) {
  const reviewConfig = loadReviewConfig(env);
  const dashboardToken = env.DASHBOARD_TOKEN;
  const tokenProvider = new InstallationTokenProvider({
    clientId: env.APP_CLIENT_ID || env.APP_ID,
    privateKey: loadPrivateKey(env),
  });
  const { server, queue } = createAppServer({
    webhookSecret: env.GITHUB_WEBHOOK_SECRET,
    tokenProvider,
    reviewConfig,
    logger,
    dashboardToken,
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
