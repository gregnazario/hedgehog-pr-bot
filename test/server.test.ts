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

test("accepted pull_request webhook returns 202 before GitHub calls", async (t) => {
  const secret = "test-secret";
  let releaseToken: () => void = () => {};
  const tokenGate = new Promise<void>((resolve) => {
    releaseToken = resolve;
  });
  const checks: NewCheckRun[] = [];
  const { server, queue } = createAppServer({
    webhookSecret: secret,
    tokenProvider: {
      get: async () => {
        await tokenGate;
        return "token";
      },
    },
    reviewConfig: {
      author: "gregnazario",
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
      listIssueReactions: async () => [],
      createIssueReaction: async () => ({ id: 1 }),
      createCheckRun: async (_repo, payload) => {
        checks.push(payload);
        return { id: 9 };
      },
      listPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
      createPullRequestReview: async () => {},
      updateCheckRun: async () => {},
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
  assert.equal(checks.length, 0);
  releaseToken();
  await queue.onIdle();
  assert.equal(checks.length, 1);
  assert.equal(checks[0].name, "Pi review");
});

test("does not start progress when this head is already reviewed", async (t) => {
  const secret = "test-secret";
  const checks: NewCheckRun[] = [];
  const { server, queue } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "token" },
    reviewConfig: {
      author: "gregnazario",
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
  assert.equal(checks.length, 0);
});

test("does not start progress for skip-review PRs", async (t) => {
  const secret = "test-secret";
  let checked = false;
  const { server } = createAppServer({
    webhookSecret: secret,
    tokenProvider: { get: async () => "token" },
    reviewConfig: {
      author: "gregnazario",
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
