import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createAppServer } from "../src/server.ts";
import type { NewCheckRun } from "../src/types.ts";

test("serves health checks and authenticates webhook pings", async (t) => {
  const secret = "test-secret";
  const { server } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "unused" },
    reviewConfig: {
      author: "gregnazario",
      authors: ["gregnazario"],
      botLogin: "hedgehog-pr-bot",
      fingerprint: "abc123",
      models: [],
      maxDiffChars: 1000,
    },
    logger: { log() {}, error() {} },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;

  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, queued: 0 });

  const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(metrics.status, 200);
  assert.match(await metrics.text(), /# TYPE queue_depth gauge\nqueue_depth 0/);

  const body = Buffer.from("{}");
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const ping = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": "ping",
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  assert.equal(ping.status, 200);

  const rejected = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: { "X-GitHub-Event": "ping", "X-Hub-Signature-256": "sha256=bad" },
    body,
  });
  assert.equal(rejected.status, 401);
});

function pullRequestWebhookBody() {
  return JSON.stringify({
    action: "synchronize",
    number: 7,
    installation: { id: 1 },
    repository: { full_name: "gregnazario/example" },
    pull_request: {
      draft: false,
      user: { login: "gregnazario" },
      head: { sha: "abcdef1dead" },
      labels: [],
    },
  });
}

test("accepted pull_request webhook opens a queued check before the review runs", async (t) => {
  const secret = "test-secret";
  let releaseReview: () => void = () => {};
  const reviewGate = new Promise<void>((resolve) => {
    releaseReview = resolve;
  });
  const checks: NewCheckRun[] = [];
  const updates: any[] = [];
  let pullsFetched = 0;
  const { server, queue } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "token" },
    reviewConfig: {
      author: "gregnazario",
      authors: ["gregnazario"],
      botLogin: "hedgehog-pr-bot",
      fingerprint: "abc123",
      models: [],
      maxDiffChars: 1000,
    },
    logger: { log() {}, error() {} },
    createClient: () => ({
      getPullRequest: async () => {
        pullsFetched += 1;
        await reviewGate;
        return {
          number: 7,
          state: "open",
          draft: false,
          user: { login: "gregnazario" },
          head: { sha: "abcdef1dead" },
        };
      },
      listIssueLabels: async () => [],
      listIssueReactions: async () => [],
      createIssueReaction: async () => ({ id: 1 }),
      createCheckRun: async (_repo, payload) => {
        checks.push(payload);
        return { id: 9 };
      },
      listPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
      createPullRequestReview: async () => {},
      updateCheckRun: async (_repo, _id, payload) => updates.push(payload),
      deleteIssueReaction: async () => {},
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  const body = Buffer.from(pullRequestWebhookBody());
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "queued");
  assert.equal(updates.length, 0);
  releaseReview();
  await queue.onIdle();
  assert.equal(pullsFetched, 2);
  assert.equal(checks.length, 1);
  const adopted = updates.find((update) => update.status === "in_progress");
  assert.equal(adopted?.title, "👀 Reviewing…");
  assert.equal(updates[updates.length - 1].status, "completed");
});

test("does not start progress when this head is already reviewed", async (t) => {
  const secret = "test-secret";
  const checks: NewCheckRun[] = [];
  const updates: any[] = [];
  const { server, queue } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "token" },
    reviewConfig: {
      author: "gregnazario",
      authors: ["gregnazario"],
      botLogin: "hedgehog-pr-bot",
      fingerprint: "abc123",
      models: [],
      maxDiffChars: 1000,
    },
    logger: { log() {}, error() {} },
    createClient: () => ({
      getPullRequest: async () => ({
        number: 7,
        state: "open",
        draft: false,
        user: { login: "gregnazario" },
        head: { sha: "abcdef1dead" },
      }),
      listIssueLabels: async () => [],
      createCheckRun: async (_repo, payload) => {
        checks.push(payload);
        return { id: 9 };
      },
      updateCheckRun: async (_repo, _id, payload) => updates.push(payload),
      listPullRequestReviews: async () => [
        {
          id: 1,
          state: "APPROVED",
          user: { type: "Bot", login: "hedgehog-pr-bot[bot]" },
          body: "<!-- greg-pr-bot-review head:abcdef1dead config:abc123 -->\ndone",
        },
      ],
      getPullRequestDiff: async () => "",
      createPullRequestReview: async () => {},
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  const body = Buffer.from(pullRequestWebhookBody());
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: true });
  await queue.onIdle();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "queued");
  assert.equal(updates[updates.length - 1].conclusion, "skipped");
  assert.match(updates[updates.length - 1].title, /Already reviewed/);
});

test("does not start progress for skip-review PRs", async (t) => {
  const secret = "test-secret";
  let checked = false;
  const { server } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "token" },
    reviewConfig: {
      author: "gregnazario",
      authors: ["gregnazario"],
      botLogin: "hedgehog-pr-bot",
      fingerprint: "abc123",
      models: [],
      maxDiffChars: 1000,
    },
    logger: { log() {}, error() {} },
    createClient: () => ({
      getPullRequest: async () => ({
        number: 7,
        state: "open",
        draft: false,
        user: { login: "gregnazario" },
        head: { sha: "abc" },
      }),
      listIssueLabels: async () => [{ name: "skip-review" }],
      createCheckRun: async () => {
        checked = true;
      },
      listPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
      createPullRequestReview: async () => {},
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  const payload = JSON.stringify({
    action: "opened",
    number: 7,
    installation: { id: 1 },
    repository: { full_name: "gregnazario/example" },
    pull_request: {
      draft: false,
      user: { login: "gregnazario" },
      head: { sha: "abc" },
      labels: [{ name: "skip-review" }],
    },
  });
  const body = Buffer.from(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": "pull_request",
      "X-Hub-Signature-256": signature,
    },
    body,
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { accepted: false });
  assert.equal(checked, false);
});
