import assert from "node:assert/strict";
import test from "node:test";
import { reviewJobFromWebhook, verifyWebhookSignature } from "../src/webhook.ts";

test("validates GitHub's documented webhook signature vector", () => {
  const body = Buffer.from("Hello, World!");
  const signature = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
  assert.equal(verifyWebhookSignature("It's a Secret to Everybody", body, signature), true);
  assert.equal(verifyWebhookSignature("wrong", body, signature), false);
});

function pullRequestPayload(overrides: Record<string, any> = {}) {
  return {
    action: "synchronize",
    number: 42,
    installation: { id: 123 },
    repository: { full_name: "gregnazario/example" },
    pull_request: {
      draft: false,
      user: { login: "gregnazario" },
      head: { sha: "abcdef" },
      labels: [],
      ...overrides.pull_request,
    },
    ...overrides,
  };
}

test("creates jobs only for reviewable pull request events", () => {
  const payload = pullRequestPayload();
  assert.deepEqual(reviewJobFromWebhook("pull_request", payload, "gregnazario"), {
    key: "gregnazario/example#42",
    fullName: "gregnazario/example",
    number: 42,
    installationId: 123,
    headSha: "abcdef",
    force: false,
  });
  assert.equal(
    reviewJobFromWebhook("pull_request", { ...payload, action: "closed" }, "gregnazario"),
    null,
  );
  assert.equal(
    reviewJobFromWebhook("pull_request", { ...payload, action: "labeled" }, "gregnazario"),
    null,
  );
  assert.equal(reviewJobFromWebhook("issues", payload, "gregnazario"), null);
});

test("does not enqueue skip-review pull requests", () => {
  const payload = pullRequestPayload({
    pull_request: {
      draft: false,
      user: { login: "gregnazario" },
      head: { sha: "abcdef" },
      labels: [{ name: "skip-review" }],
    },
  });
  assert.equal(reviewJobFromWebhook("pull_request", payload, "gregnazario"), null);
});

test("enqueues /review from the author with force", () => {
  const payload = {
    action: "created",
    installation: { id: 123 },
    repository: { full_name: "gregnazario/example" },
    comment: { body: "/review now", user: { login: "gregnazario" } },
    issue: {
      number: 42,
      draft: false,
      user: { login: "gregnazario" },
      labels: [],
      pull_request: {},
    },
  };
  assert.deepEqual(reviewJobFromWebhook("issue_comment", payload, "gregnazario"), {
    key: "gregnazario/example#42",
    fullName: "gregnazario/example",
    number: 42,
    installationId: 123,
    force: true,
  });
});

test("issue_comment /review ignores missing draft/head fields and still enqueues", () => {
  const payload = {
    action: "created",
    installation: { id: 123 },
    repository: { full_name: "gregnazario/example" },
    comment: { body: "/review", user: { login: "gregnazario" } },
    issue: {
      number: 42,
      user: { login: "gregnazario" },
      labels: [],
      pull_request: { url: "https://api.github.com/repos/gregnazario/example/pulls/42" },
    },
  };
  const job = reviewJobFromWebhook("issue_comment", payload, "gregnazario");
  assert.ok(job);
  assert.equal(job.force, true);
});

test("ignores /review from other users, skip-review, and lookalikes", () => {
  const base = {
    action: "created",
    installation: { id: 123 },
    repository: { full_name: "gregnazario/example" },
    comment: { body: "/review", user: { login: "gregnazario" } },
    issue: {
      number: 42,
      user: { login: "gregnazario" },
      labels: [],
      pull_request: {},
    },
  };
  assert.equal(
    reviewJobFromWebhook(
      "issue_comment",
      {
        ...base,
        comment: { body: "/review", user: { login: "someone-else" } },
      },
      "gregnazario",
    ),
    null,
  );
  assert.equal(
    reviewJobFromWebhook(
      "issue_comment",
      {
        ...base,
        comment: { body: "/review-foo", user: { login: "gregnazario" } },
      },
      "gregnazario",
    ),
    null,
  );
  assert.equal(
    reviewJobFromWebhook(
      "issue_comment",
      {
        ...base,
        issue: { ...base.issue, labels: [{ name: "skip-review" }] },
      },
      "gregnazario",
    ),
    null,
  );
});
