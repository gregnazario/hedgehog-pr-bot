import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppServer } from "../src/server.ts";
import type { AppClient, NewCheckRun } from "../src/types.ts";
import { reviewJobFromWebhook } from "../src/webhook.ts";

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
      createIssueComment: async () => {},
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

  const dashboard = await fetch(`http://127.0.0.1:${port}/dashboard.json`);
  assert.equal(dashboard.status, 200);
  const payload = (await dashboard.json()) as {
    jobs: Array<{ status: string; repository: string }>;
  };
  assert.equal(payload.jobs[0].status, "reviewed");
  assert.equal(payload.jobs[0].repository, "gregnazario/example");
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
      createIssueComment: async () => {},
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
      createIssueComment: async () => {},
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

test("dashboard requires its token when one is configured", async (t) => {
  const secret = "test-secret";
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
    dashboardToken: "letmein",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address() as AddressInfo;
  assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard`)).status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/dashboard?token=letmein`)).status, 200);
});

const fakeModelBin = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "hedgehog-modelbin-"));
  const script = join(dir, "model");
  await writeFile(
    script,
    '#!/bin/sh\necho \'{"title":"Add the export","body":"- adds the export","summary":"Checked.","findings":[]}\'\n',
    { mode: 0o755 },
  );
  return script;
};

const withModelBin = async (fn: () => Promise<unknown>) => {
  const previous = process.env.PI_BIN;
  process.env.PI_BIN = await fakeModelBin();
  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.PI_BIN;
    else process.env.PI_BIN = previous;
  }
};

function sign(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const waitFor = async (
  label: string,
  test: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

async function postWebhook(port: number, secret: string, event: string, payload: unknown) {
  const body = Buffer.from(JSON.stringify(payload));
  return fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: "POST",
    headers: {
      "X-GitHub-Event": event,
      "X-Hub-Signature-256": sign(secret, body),
    },
    body,
  });
}

const fullReviewConfig = {
  author: "gregnazario",
  authors: ["gregnazario"],
  botLogin: "hedgehog-pr-bot",
  fingerprint: "abc123",
  models: [{ provider: "zai", model: "glm-5.3", thinking: "high", label: "zai/glm-5.3:high" }],
  maxDiffChars: 1000,
};

test("/describe flows from webhook to posted description comment", async (t) => {
  await withModelBin(async () => {
    const secret = "test-secret";
    const comments: string[] = [];
    const { server } = createAppServer({
      webhookSecret: secret,
      tokenProvider: { get: async () => "token" },
      reviewConfig: fullReviewConfig,
      logger: { log() {}, error() {} },
      createClient: () => ({
        getPullRequest: async () => ({
          number: 7,
          state: "open",
          title: "Old",
          user: { login: "gregnazario" },
          head: { sha: "abc", ref: "f" },
          base: { ref: "main", sha: "base" },
        }),
        getPullRequestDiff: async () =>
          "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,2 @@\n ctx\n+added\n",
        listPullRequestReviews: async () => [],
        createCheckRun: async () => ({ id: 1 }),
        createIssueComment: async (_repo, _number, body) => {
          comments.push(body);
        },
        createPullRequestReview: async () => {},
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;

    const response = await postWebhook(port, secret, "issue_comment", {
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "gregnazario/example" },
      comment: { id: 55, body: "/describe", user: { login: "gregnazario" } },
      issue: { number: 7, user: { login: "gregnazario" }, labels: [], pull_request: {} },
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true });
    await waitFor("describe job", () => comments.length === 1);

    assert.equal(comments.length, 1);
    assert.match(comments[0], /Suggested description/);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(metrics, /describe_jobs_total 1/);
    const dashboard = (await (await fetch(`http://127.0.0.1:${port}/dashboard.json`)).json()) as {
      jobs: Array<{ status: string }>;
    };
    assert.equal(dashboard.jobs[0].status, "described");
  });
});

test("/ignore flows from webhook to resolved thread and ack", async (t) => {
  await withModelBin(async () => {
    const secret = "test-secret";
    const resolved: string[] = [];
    const reactions: Array<[number, string]> = [];
    const { server } = createAppServer({
      webhookSecret: secret,
      tokenProvider: { get: async () => "token" },
      reviewConfig: {
        ...fullReviewConfig,
        memoryPath: join(await mkdtemp(join(tmpdir(), "hedgehog-mem-")), "ignores.json"),
      },
      logger: { log() {}, error() {} },
      createClient: () =>
        ({
          getPullRequest: async () => ({
            number: 7,
            state: "open",
            title: "T",
            user: { login: "gregnazario" },
            head: { sha: "abc", ref: "f" },
          }),
          getPullRequestDiff: async () => "",
          listPullRequestReviews: async () => [],
          createCheckRun: async () => ({ id: 1 }),
          createPullRequestReview: async () => {},
          getReviewComment: async () => ({
            id: 501,
            path: "src/app.mjs",
            body: "**High:** The cache is never cleared.",
            user: { login: "hedgehog-pr-bot[bot]" },
          }),
          listUnresolvedHedgehogThreads: async () => [{ commentId: 501, threadId: "T501" }],
          resolveReviewThread: async (threadId: string) => resolved.push(threadId),
          reactToReviewComment: async (_repo: string, commentId: number, content: string) => {
            reactions.push([commentId, content]);
          },
        }) as unknown as AppClient,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;

    const response = await postWebhook(port, secret, "pull_request_review_comment", {
      action: "created",
      installation: { id: 1 },
      repository: { full_name: "gregnazario/example" },
      pull_request: { number: 7 },
      comment: { id: 602, in_reply_to_id: 501, body: "/ignore", user: { login: "gregnazario" } },
    });
    assert.equal(response.status, 202);
    await waitFor("ignore job", () => resolved.length === 1 && reactions.length === 1);

    assert.deepEqual(resolved, ["T501"]);
    assert.deepEqual(reactions, [[602, "+1"]]);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(metrics, /ignore_jobs_total 1/);
  });
});

test("MAX_REVIEWS_PER_HOUR caps the webhook path with a skipped check", async (t) => {
  await withModelBin(async () => {
    const secret = "test-secret";
    const updates: any[] = [];
    const reviews: any[] = [];
    let pulls = 0;
    const { server } = createAppServer({
      webhookSecret: secret,
      tokenProvider: { get: async () => "token" },
      reviewConfig: { ...fullReviewConfig, reviewCapPerHour: 1 },
      logger: { log() {}, error() {} },
      createClient: () =>
        ({
          getPullRequest: async () => {
            pulls += 1;
            return {
              number: 7,
              state: "open",
              draft: false,
              user: { login: "gregnazario" },
              head: { sha: `abc${pulls}`, ref: "f" },
              base: { ref: "main" },
            };
          },
          listIssueLabels: async () => [],
          createIssueReaction: async () => ({ id: 1 }),
          createCheckRun: async () => ({ id: 9 }),
          updateCheckRun: async (_repo: string, _id: number, payload: unknown) =>
            updates.push(payload),
          listPullRequestReviews: async () => [],
          getPullRequestDiff: async () => "",
          createPullRequestReview: async (_repo: string, _number: number, payload: unknown) =>
            reviews.push(payload),
          createIssueComment: async () => {},
        }) as unknown as AppClient,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const { port } = server.address() as AddressInfo;

    for (const number of [7, 8]) {
      const body = Buffer.from(
        JSON.stringify({
          action: "synchronize",
          number,
          installation: { id: 1 },
          repository: { full_name: "gregnazario/example" },
          pull_request: {
            draft: false,
            user: { login: "gregnazario" },
            head: { sha: `head${number}` },
            labels: [],
          },
        }),
      );
      const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
        method: "POST",
        headers: {
          "X-GitHub-Event": "pull_request",
          "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
        body,
      });
      assert.equal(response.status, 202);
    }

    await waitFor(
      "cap skip",
      async () =>
        /review_cap_skips_total 1/.test(
          await (await fetch(`http://127.0.0.1:${port}/metrics`)).text(),
        ) && reviews.length >= 1,
    );
    assert.equal(reviews.length, 1);
    const capped = updates.find(
      (update) => update.conclusion === "skipped" && /cap/i.test(update.title ?? ""),
    );
    assert.ok(capped, `expected a cap skip among ${JSON.stringify(updates.map((u) => u.title))}`);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    assert.match(metrics, /review_cap_skips_total 1/);
    const dashboard = (await (await fetch(`http://127.0.0.1:${port}/dashboard.json`)).json()) as {
      jobs: Array<{ status: string }>;
    };
    assert.ok(dashboard.jobs.some((job) => job.status === "capped"));
  });
});

test("/review <category> rejects prototype keys", () => {
  const payload = {
    action: "created",
    installation: { id: 123 },
    repository: { full_name: "gregnazario/example" },
    comment: { id: 7, body: "/review constructor", user: { login: "gregnazario" } },
    issue: { number: 42, user: { login: "gregnazario" }, labels: [], pull_request: {} },
  };
  assert.equal(reviewJobFromWebhook("issue_comment", payload, "gregnazario")?.focus, undefined);
});
