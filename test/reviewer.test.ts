import assert from "node:assert/strict";
import test from "node:test";
import { findingFingerprint } from "../src/memory.ts";
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
    verifyModel: async () => '{"verdicts":[]}',
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

test("deduplicates multi-model findings that share an anchor", async () => {
  let posted: any;
  const twoModelConfig = {
    author: "gregnazario",
    authors: ["gregnazario"],
    botLogin: "hedgehog-pr-bot",
    maxDiffChars: 10_000,
    fingerprint: "abc123",
    models: [
      { provider: "zai", model: "glm-5.3", thinking: "high", label: "zai/glm-5.3:high" },
      { provider: "anthropic", model: "claude", thinking: "high", label: "anthropic/claude:high" },
    ],
  };
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: twoModelConfig,
    runModel: async (_bundle, modelSpec) =>
      modelSpec.provider === "zai"
        ? JSON.stringify({
            summary: "Zai pass.",
            findings: [
              {
                severity: "Low",
                path: "src/app.mjs",
                line: 4,
                side: "RIGHT",
                body: "Check VERSION.",
              },
            ],
          })
        : JSON.stringify({
            summary: "Claude pass.",
            findings: [
              {
                severity: "Critical",
                path: "src/app.mjs",
                line: 4,
                side: "RIGHT",
                body: "VERSION leaks a secret.",
              },
            ],
          }),
    verifyModel: async () => '{"verdicts":[]}',
    logger: { log() {}, error() {} },
  });
  assert.ok(result.status === "reviewed");
  assert.equal(posted.comments.length, 1);
  assert.match(posted.comments[0].body, /zai\/glm-5\.3:high, anthropic\/claude:high/);
  assert.match(posted.comments[0].body, /\*\*Critical:\*\*/);
  assert.deepEqual(result.severities, ["Critical"]);
});

test("notes truncated diffs in the review body", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: { ...config, maxDiffChars: 10 },
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.match(posted.body, /diff exceeded the configured size limit/);
});

test("reports per-model progress on the review check", async () => {
  const updates: any[] = [];
  const twoModelConfig = {
    author: "gregnazario",
    authors: ["gregnazario"],
    botLogin: "hedgehog-pr-bot",
    maxDiffChars: 10_000,
    fingerprint: "abc123",
    models: [
      { provider: "zai", model: "glm-5.3", thinking: "high", label: "zai/glm-5.3:high" },
      { provider: "zai", model: "glm-4.7", thinking: "high", label: "zai/glm-4.7:high" },
    ],
  };
  const client = baseClient({
    createPullRequestReview: async () => {},
    updateCheckRun: async (_repo, _id, payload) => updates.push(payload),
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: twoModelConfig,
    checkRunId: 55,
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  const progress = updates.filter((update) => update.status === "in_progress");
  assert.equal(progress.length, 2);
  assert.match(progress[0].summary, /1\/2 models done/);
  assert.match(progress[1].summary, /2\/2 models done/);
  assert.equal(progress[0].title, "👀 Reviewing…");
  assert.equal(updates[updates.length - 1].status, "completed");
});

test("ignored fingerprints drop matching findings", async () => {
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
    ignoredFingerprints: new Set([
      findingFingerprint({ path: "src/app.mjs", body: "Is VERSION used?" }),
    ]),
    runModel: async () => jsonReview(),
    logger: { log() {}, error() {} },
  });
  assert.ok(result.status === "reviewed");
  assert.equal(posted.event, "APPROVE");
  assert.equal(posted.comments, undefined);
  assert.match(posted.body, /No new findings/);
});

test("halves the diff cap and retries when the prompt exceeds model limits", async () => {
  let posted: any;
  const seenBundles: number[] = [];
  const client = baseClient({
    getPullRequestDiff: async () => `diff --git a/src/app.mjs b/src/app.mjs
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,1 +1,${"x".length} @@
+${"line\n+".repeat(50).slice(0, -1)}
`,
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  const result = await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: { ...config, maxDiffChars: 400 },
    runModel: async (reviewBundle) => {
      seenBundles.push(reviewBundle.length);
      if (seenBundles.length === 1) throw new Error("Prompt exceeds max length");
      return jsonReview();
    },
    logger: { log() {}, error() {} },
  });
  assert.ok(result.status === "reviewed");
  assert.equal(seenBundles.length, 2);
  assert.ok(seenBundles[1] < seenBundles[0]);
  assert.match(posted.body, /diff exceeded the configured size limit/);
});

test("fails after three prompt-length retries", async () => {
  const attempts: number[] = [];
  const client = baseClient({
    updateCheckRun: async () => {},
  });
  await assert.rejects(
    () =>
      reviewPullRequest({
        client,
        fullName: "gregnazario/example",
        number: 7,
        config: { ...config, maxDiffChars: 400 },
        runModel: async (reviewBundle) => {
          attempts.push(reviewBundle.length);
          throw new Error("Prompt exceeds max length");
        },
        logger: { log() {}, error() {} },
      }),
    /max length/,
  );
  assert.equal(attempts.length, 4);
});

const confirmAll = async () => '{"verdicts":[]}';

test("verification drops a disproven Critical finding", async () => {
  let posted: any;
  let verifyBundle = "";
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
        summary: "Maybe a leak.",
        findings: [
          {
            severity: "Critical",
            path: "src/app.mjs",
            line: 4,
            side: "RIGHT",
            body: "VERSION leaks a secret.",
          },
        ],
      }),
    verifyModel: async (bundle) => {
      verifyBundle = bundle;
      return JSON.stringify({ verdicts: [{ index: 0, verdict: "drop" }] });
    },
    logger: { log() {}, error() {} },
  });
  assert.ok(result.status === "reviewed");
  assert.match(verifyBundle, /0\. \[Critical\]/);
  assert.equal(posted.event, "APPROVE");
  assert.equal(posted.comments, undefined);
});

test("verification downgrades High findings to the given severity", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Risky.",
        findings: [
          { severity: "High", path: "src/app.mjs", line: 4, side: "RIGHT", body: "Risky default." },
        ],
      }),
    verifyModel: async () =>
      JSON.stringify({ verdicts: [{ index: 0, verdict: "downgrade", severity: "Low" }] }),
    logger: { log() {}, error() {} },
  });
  assert.equal(posted.event, "COMMENT");
  assert.match(posted.comments[0].body, /\*\*Low:\*\*/);
});

test("unparseable verification output keeps the original findings", async () => {
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    runModel: async () =>
      JSON.stringify({
        summary: "Real risk.",
        findings: [
          { severity: "High", path: "src/app.mjs", line: 4, side: "RIGHT", body: "Risky default." },
        ],
      }),
    verifyModel: async () => "I could not produce JSON",
    logger: { log() {}, error() {} },
  });
  assert.equal(posted.event, "REQUEST_CHANGES");
});

test("REVIEW_VERIFY=false skips the verification pass", async () => {
  let verifyCalls = 0;
  const client = baseClient({
    createPullRequestReview: async () => {},
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: { ...config, verifyFindings: false },
    runModel: async () =>
      JSON.stringify({
        summary: "Risk.",
        findings: [
          { severity: "High", path: "src/app.mjs", line: 4, side: "RIGHT", body: "Risky default." },
        ],
      }),
    verifyModel: async () => {
      verifyCalls += 1;
      return "{}";
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(verifyCalls, 0);
});

test("touched-file contents are embedded in the review bundle", async () => {
  let bundle = "";
  const client = baseClient({
    getFileContents: async (_repo, path) =>
      path === "src/app.mjs" ? "export function add(a, b) {\n  return a + b;\n}\n" : "",
    createPullRequestReview: async () => {},
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: { ...config, fileContextBytes: 4096 },
    runModel: async (reviewBundle) => {
      bundle = reviewBundle;
      return jsonReview();
    },
    verifyModel: confirmAll,
    logger: { log() {}, error() {} },
  });
  assert.match(bundle, /<touched_files>/);
  assert.match(bundle, /<file path="src\/app\.mjs">/);
  assert.match(bundle, /return a \+ b;/);
});

test("huge diffs route to PI_MODELS_LARGE", async () => {
  const seenLabels: string[] = [];
  const bigDiff = `diff --git a/src/app.mjs b/src/app.mjs
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,1 +1,2 @@
 context
+${"x".repeat(600_000)}
`;
  const client = baseClient({
    getPullRequestDiff: async () => bigDiff,
    createPullRequestReview: async () => {},
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config: {
      ...config,
      largeModels: [
        { provider: "zai", model: "glm-4.7", thinking: "low", label: "zai/glm-4.7:low" },
      ],
    },
    runModel: async (_bundle, modelSpec) => {
      seenLabels.push(modelSpec.label);
      return jsonReview();
    },
    verifyModel: confirmAll,
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(seenLabels, ["zai/glm-4.7:low"]);
});

test("repo config min_severity drops low findings", async () => {
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
    repoConfig: { minSeverity: "High" },
    runModel: async () => jsonReview(),
    verifyModel: confirmAll,
    logger: { log() {}, error() {} },
  });
  assert.ok(result.status === "reviewed");
  assert.equal(posted.event, "APPROVE");
  assert.equal(posted.comments, undefined);
});

test("repo config can disable the verification pass", async () => {
  let verifyCalls = 0;
  const client = baseClient({
    createPullRequestReview: async () => {},
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    repoConfig: { verify: false },
    runModel: async () =>
      JSON.stringify({
        summary: "Risk.",
        findings: [
          { severity: "High", path: "src/app.mjs", line: 4, side: "RIGHT", body: "Risky default." },
        ],
      }),
    verifyModel: async () => {
      verifyCalls += 1;
      return "{}";
    },
    logger: { log() {}, error() {} },
  });
  assert.equal(verifyCalls, 0);
});

test("repo config models override the server list", async () => {
  const seenLabels: string[] = [];
  const client = baseClient({
    createPullRequestReview: async () => {},
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    repoConfig: {
      models: [{ provider: "zai", model: "glm-4.7", thinking: "low", label: "zai/glm-4.7:low" }],
    },
    runModel: async (_bundle, modelSpec) => {
      seenLabels.push(modelSpec.label);
      return jsonReview();
    },
    verifyModel: confirmAll,
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(seenLabels, ["zai/glm-4.7:low"]);
});

test("repo instructions land in the bundle and walkthroughs land in the body", async () => {
  let seenBundle = "";
  let posted: any;
  const client = baseClient({
    createPullRequestReview: async (_repo, _number, payload) => {
      posted = payload;
    },
  });
  await reviewPullRequest({
    client,
    fullName: "gregnazario/example",
    number: 7,
    config,
    repoConfig: {
      instructions: "Flag client-only hooks.",
      walkthrough: true,
    },
    runModel: async (bundle) => {
      seenBundle = bundle;
      return JSON.stringify({
        summary: "Checked.",
        walkthrough: "- **src/app.mjs**: adds the VERSION export",
        findings: [],
      });
    },
    logger: { log() {}, error() {} },
  });
  assert.match(seenBundle, /Maintainer guidance:\nFlag client-only hooks\./);
  assert.match(seenBundle, /"walkthrough" field/);
  assert.match(posted.body, /### Walkthrough\n\n- \*\*src\/app\.mjs\*\*/);
});
