import assert from "node:assert/strict";
import test from "node:test";
import { buildPiEnvironment, reviewPullRequest } from "../src/reviewer.mjs";

const config = {
  author: "gregnazario",
  maxDiffChars: 10_000,
  fingerprint: "abc123",
  models: [{ provider: "zai", model: "glm-5.3", thinking: "high", label: "zai/glm-5.3:high" }],
};

const sampleDiff = `diff --git a/src/app.mjs b/src/app.mjs
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,3 +1,4 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
+export const VERSION = 1;
`;

function pullRequest() {
  return {
    number: 7,
    state: "open",
    draft: false,
    title: "Change",
    body: "Body",
    user: { login: "gregnazario" },
    head: { sha: "1234567890", ref: "feature" },
    base: { ref: "main" },
  };
}

function jsonReview() {
  return JSON.stringify({
    summary: "The addition looks right; check the new export.",
    findings: [{
      severity: "Low",
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
      body: "Is VERSION used?",
    }],
  });
}

test("posts an inline GitHub review for a new PR head", async () => {
  let posted;
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async (_repo, _number, payload) => (posted = payload),
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.commitId, "1234567890");
  assert.equal(posted.event, "COMMENT");
  assert.match(posted.body, /head:1234567890 config:abc123/);
  assert.match(posted.body, /The addition looks right/);
  assert.equal(posted.comments.length, 1);
  assert.deepEqual(posted.comments[0], {
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: "**Low:** Is VERSION used?",
  });
});

test("does not rerun a current inline review", async () => {
  let ran = false;
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [{
      user: { type: "Bot" },
      body: "<!-- greg-pr-bot-review head:1234567890 config:abc123 -->\nold",
    }],
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => (ran = true),
    logger: { log() {} },
  });
  assert.equal(result.status, "skipped_current");
  assert.equal(ran, false);
});

test("re-reviews a PR that only has a legacy issue comment and removes that note", async () => {
  const deleted = [];
  let posted;
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [{
      id: 55,
      user: { type: "Bot" },
      body: "<!-- greg-pr-bot-review head:1234567890 config:abc123 -->\nlegacy blob",
    }],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async (_repo, _number, payload) => (posted = payload),
    deleteIssueComment: async (_repo, commentId) => deleted.push(commentId),
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.comments.length, 1);
  assert.deepEqual(deleted, [55]);
});

test("retries with a summary-only review when inline comments are rejected", async () => {
  const payloads = [];
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async (_repo, _number, payload) => {
      payloads.push(payload);
      if (payload.comments?.length) throw new Error("GitHub returned 422: line could not be resolved");
    },
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].comments.length, 1);
  assert.equal(payloads[1].comments, undefined);
  assert.match(payloads[1].body, /The addition looks right/);
});

test("attaches comments one at a time after a batch review is rejected", async () => {
  const singles = [];
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async (_repo, _number, payload) => {
      if (payload.comments?.length) throw new Error("GitHub returned 422: line could not be resolved");
    },
    createPullRequestReviewComment: async (_repo, _number, payload) => singles.push(payload),
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(singles.length, 1);
  assert.equal(singles[0].path, "src/app.mjs");
  assert.equal(singles[0].line, 4);
  assert.equal(singles[0].commitId, "1234567890");
});

test("posts a summary-only review when the model returns markdown instead of JSON", async () => {
  let posted;
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async (_repo, _number, payload) => (posted = payload),
  };
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => "No actionable issues found.",
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.comments, undefined);
  assert.match(posted.body, /No actionable issues found/);
});

test("sends annotated diffs with line numbers to the model", async () => {
  let bundle;
  const client = {
    getPullRequest: async () => pullRequest(),
    listIssueComments: async () => [],
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    createPullRequestReview: async () => {},
  };
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async (reviewBundle) => {
      bundle = reviewBundle;
      return jsonReview();
    },
    logger: { log() {}, error() {} },
  });
  assert.match(bundle, /\[RIGHT 4\] \+export const VERSION = 1;/);
  assert.match(bundle, /\[LEFT 2\] -  return a - b;/);
});

test("removes GitHub App and webhook secrets from Pi's environment", () => {
  const env = buildPiEnvironment({
    PATH: "/bin",
    ZAI_API_KEY: "model-key",
    GH_TOKEN: "installation-token",
    APP_PRIVATE_KEY_BASE64: "private-key",
    GITHUB_WEBHOOK_SECRET: "webhook-secret",
  });
  assert.deepEqual(env, { PATH: "/bin", ZAI_API_KEY: "model-key" });
});
