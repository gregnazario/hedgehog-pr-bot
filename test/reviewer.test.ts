import assert from "node:assert/strict";
import test from "node:test";
import { buildPiEnvironment, buildReviewBundle, reviewPullRequest } from "../src/reviewer.ts";
import type { CheckRunUpdate, ReviewerClient } from "../src/types.ts";

const config = {
  author: "gregnazario",
  authors: ["gregnazario"],
  botLogin: "hedgehog-pr-bot",
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
    findings: [
      {
        severity: "Low",
        path: "src/app.mjs",
        line: 4,
        side: "RIGHT",
        body: "Is VERSION used?",
      },
    ],
  });
}

type ClientOverrides = Partial<ReviewerClient> & {
  listIssueComments?: unknown;
  deleteIssueComment?: unknown;
};

function baseClient(overrides: ClientOverrides = {}): ReviewerClient {
  return {
    getPullRequest: async () => pullRequest(),
    listPullRequestReviews: async () => [],
    getPullRequestDiff: async () => sampleDiff,
    listUnresolvedHedgehogThreads: async () => [],
    ...overrides,
  } as ReviewerClient;
}

test("posts an inline COMMENT review for a Low finding", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.ok(result.status === "reviewed");
  assert.equal(result.event, "COMMENT");
  assert.equal(posted.commitId, "1234567890");
  assert.equal(posted.event, "COMMENT");
  assert.match(posted.body, /head:1234567890 config:abc123/);
  assert.match(posted.body, /The addition looks right/);
  assert.match(posted.body, /ℹ️ 1 Low/);
  assert.doesNotMatch(posted.body, /inline comments were left/);
  assert.equal(posted.comments.length, 1);
  assert.deepEqual(posted.comments[0], {
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: "**Low:** Is VERSION used?",
  });
});

test("requests changes for a High finding on a deleted line", async () => {
  let posted: any;
  const client = baseClient({
    getPullRequestDiff: async () => `diff --git a/gone.mjs b/gone.mjs
deleted file mode 100644
--- a/gone.mjs
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`,
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Don't drop this.",
        findings: [
          {
            severity: "High",
            path: "gone.mjs",
            line: 1,
            side: "LEFT",
            body: "This export is still used.",
          },
        ],
      }),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.event, "REQUEST_CHANGES");
  assert.deepEqual(posted.comments, [
    {
      path: "gone.mjs",
      line: 1,
      side: "LEFT",
      body: "**High:** This export is still used.",
    },
  ]);
});

test("does not rerun a current inline review", async () => {
  let ran = false;
  const client = baseClient({
    listPullRequestReviews: async () => [
      {
        id: 1,
        state: "APPROVED",
        user: { type: "Bot" },
        body: "<!-- greg-pr-bot-review head:1234567890 config:abc123 -->\nold",
      },
    ],
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => {
      ran = true;
      return "";
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "skipped_current");
  assert.equal(ran, false);
});

test("force re-reviews a head that already has a marker", async () => {
  let posted: any;
  const client = baseClient({
    listPullRequestReviews: async () => [
      {
        id: 1,
        state: "APPROVED",
        user: { type: "Bot" },
        body: "<!-- greg-pr-bot-review head:1234567890 config:abc123 -->\nold",
      },
    ],
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    force: true,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.event, "COMMENT");
});

test("does not double-count unmapped findings in the tally", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Line is gone.",
        findings: [
          {
            severity: "Low",
            path: "missing.mjs",
            line: 1,
            side: "RIGHT",
            body: "Cannot map this.",
          },
        ],
      }),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.ok(result.status === "reviewed");
  assert.deepEqual(result.severities, ["Low"]);
  assert.match(posted.body, /ℹ️ 1 Low/);
  assert.doesNotMatch(posted.body, /ℹ️ 2 Low/);
});

test("leaves leftover issue comments in place", async () => {
  const deleted: unknown[] = [];
  let posted: any;
  const client = baseClient({
    listIssueComments: async () => [
      {
        id: 55,
        user: { type: "Bot" },
        body: "<!-- greg-pr-bot-review head:1234567890 config:abc123 -->\nlegacy blob",
      },
    ],
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
    deleteIssueComment: async (_repo: string, commentId: number) => deleted.push(commentId),
  });
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
  assert.deepEqual(deleted, []);
});

test("retries with a summary-only review when inline comments are rejected", async () => {
  const payloads: any[] = [];
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      payloads.push(payload);
      if (payload.comments?.length)
        throw new Error("GitHub returned 422: line could not be resolved");
    },
  });
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
  assert.doesNotMatch(payloads[1].body, /inline comments were left/);
});

test("attaches comments one at a time after a batch review is rejected", async () => {
  const singles: any[] = [];
  let updated!: { reviewId: number; body: string };
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      if (payload.comments?.length)
        throw new Error("GitHub returned 422: line could not be resolved");
      return { id: 44 };
    },
    createPullRequestReviewComment: async (_repo, _number, payload) => singles.push(payload),
    updatePullRequestReview: async (_repo, _number, reviewId, body) => {
      updated = { reviewId, body };
    },
  });
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
  assert.equal(updated.reviewId, 44);
  assert.match(updated.body, /ℹ️ 1 Low/);
});

test("approves when the model returns no findings", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () => "No actionable issues found.",
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.event, "APPROVE");
  assert.equal(posted.comments, undefined);
  assert.match(posted.body, /No new findings/);
});

test("replies still applies, resolves addressed threads, and posts moved comments", async () => {
  const replies: any[] = [];
  const resolved: any[] = [];
  let posted: any;
  const client = baseClient({
    listUnresolvedHedgehogThreads: async () => [
      {
        commentId: 101,
        threadId: "T101",
        path: "src/app.mjs",
        line: 2,
        side: "LEFT",
        severity: "High",
        body: "**High:** old subtract",
      },
      {
        commentId: 202,
        threadId: "T202",
        path: "src/app.mjs",
        line: 3,
        side: "RIGHT",
        severity: "Low",
        body: "**Low:** still",
      },
      {
        commentId: 303,
        threadId: "T303",
        path: "src/app.mjs",
        line: 1,
        side: "RIGHT",
        severity: "Medium",
        body: "**Medium:** moved",
      },
    ],
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
    createPullRequestReviewCommentReply: async (_repo, _number, id, body) =>
      replies.push({ id, body }),
    resolveReviewThread: async (id) => resolved.push(id),
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Follow-up.",
        findings: [],
        addressed_comment_ids: [101, 999],
        still_applies: [
          { id: 202 },
          {
            id: 303,
            path: "src/app.mjs",
            line: 4,
            side: "RIGHT",
            severity: "Medium",
            body: "Now on VERSION",
          },
          { id: 888 },
        ],
      }),
    logger: { log() {}, error() {} },
  });
  assert.equal(result.status, "reviewed");
  assert.equal(posted.event, "COMMENT");
  assert.equal(posted.comments.length, 1);
  assert.equal(posted.comments[0].line, 4);
  assert.match(posted.comments[0].body, /Now on VERSION/);
  assert.deepEqual(replies, [{ id: 202, body: "Still applies." }]);
  assert.deepEqual(resolved, ["T101"]);
});

test("dismisses outstanding hedgehog REQUEST_CHANGES on a Medium/Low pass", async () => {
  const dismissed: any[] = [];
  const client = baseClient({
    listPullRequestReviews: async () => [
      {
        id: 9,
        user: { type: "Bot", login: "hedgehog-pr-bot[bot]" },
        state: "CHANGES_REQUESTED",
        body: "old",
      },
      {
        id: 8,
        user: { type: "Bot", login: "cursor[bot]" },
        state: "CHANGES_REQUESTED",
        body: "cursor",
      },
    ],
    createPullRequestReview: async () => ({ id: 10 }),
    dismissPullRequestReview: async (_repo, _number, id) => dismissed.push(id),
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    force: true,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(dismissed, [9]);
});

test("does not post Still applies when hedgehog already replied", async () => {
  const replies: any[] = [];
  const client = baseClient({
    listUnresolvedHedgehogThreads: async () => [
      {
        commentId: 202,
        threadId: "T202",
        path: "src/app.mjs",
        line: 3,
        side: "RIGHT",
        severity: "Low",
        body: "**Low:** still",
        alreadyReplied: true,
      },
    ],
    createPullRequestReview: async () => {},
    createPullRequestReviewCommentReply: async (_repo, _number, id, body) =>
      replies.push({ id, body }),
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Still open.",
        findings: [],
        still_applies: [{ id: 202 }],
      }),
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(replies, []);
});

test("completes the check as failure when Pi throws", async () => {
  let outcome!: { id: number; payload: CheckRunUpdate };
  const client = baseClient({
    updateCheckRun: async (_repo, id, payload) => (outcome = { id, payload }),
    deleteIssueReaction: async () => {},
  });
  await assert.rejects(() =>
    reviewPullRequest({
      client,
      fullName: "gregnazario/example",
      number: 7,
      config,
      checkRunId: 77,
      eyesReactionId: 5,
      runModel: async () => {
        throw new Error("Pi exploded");
      },
      logger: { log() {}, error() {} },
    }),
  );
  assert.equal(outcome.id, 77);
  assert.equal(outcome.payload.conclusion, "failure");
  assert.equal(outcome.payload.title, "❌ Review failed");
});

test("sends annotated diffs and previous threads to the model", async () => {
  let bundle = "";
  const client = baseClient({
    listUnresolvedHedgehogThreads: async () => [
      {
        commentId: 101,
        threadId: "T101",
        path: "src/app.mjs",
        line: 4,
        side: "RIGHT",
        severity: "Low",
        body: "**Low:** old",
      },
    ],
    createPullRequestReview: async () => {},
  });
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
  assert.match(bundle, /\[LEFT 2\] - {2}return a - b;/);
  assert.match(bundle, /<previous_threads>/);
  assert.match(bundle, /id: 101/);
});

test("buildReviewBundle includes previous threads", () => {
  const bundle = buildReviewBundle("gregnazario/example", pullRequest(), sampleDiff, 10_000, [
    {
      commentId: 7,
      threadId: "T7",
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
      severity: "Low",
      body: "**Low:** note",
    },
  ]);
  assert.match(bundle, /id: 7 path: src\/app.mjs line: 4/);
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
