import assert from "node:assert/strict";
import test from "node:test";
import { applyDescribeJob, buildDescribeBundle, parseDescribeOutput } from "../src/describe.ts";
import { reviewJobFromWebhook } from "../src/webhook.ts";

const pullRequest = () => ({
  number: 7,
  state: "open",
  title: "Old title",
  user: { login: "gregnazario" },
  head: { sha: "abc", ref: "feature" },
  base: { ref: "main" },
});

const diff = `diff --git a/src/app.mjs b/src/app.mjs
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,2 +1,3 @@
 ctx
+added
`;

test("parseDescribeOutput extracts title and body", () => {
  assert.deepEqual(parseDescribeOutput('{"title":"Add flag","body":"Adds a flag."}'), {
    title: "Add flag",
    body: "Adds a flag.",
  });
  assert.equal(parseDescribeOutput("no json here"), null);
  assert.equal(parseDescribeOutput('{"title":"","body":"x"}'), null);
});

test("applyDescribeJob posts a suggested description comment", async () => {
  const comments: string[] = [];
  let seenBundle = "";
  const client = {
    getPullRequest: async () => pullRequest(),
    getPullRequestDiff: async () => diff,
    createIssueComment: async (_repo: string, _number: number, body: string) => {
      comments.push(body);
    },
  };
  const result = await applyDescribeJob(
    client,
    { fullName: "gregnazario/example", number: 7 },
    { maxDiffChars: 10_000 },
    async (bundle) => {
      seenBundle = bundle;
      return JSON.stringify({
        title: "Add the VERSION export",
        body: "- Exports `VERSION` from app.mjs",
      });
    },
  );
  assert.ok(result);
  assert.match(seenBundle, /Drafts? a pull-request description|draft concise/);
  assert.match(seenBundle, /\[RIGHT 2\] \+added/);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /Suggested description/);
  assert.match(comments[0], /\*\*Title:\*\* Add the VERSION export/);
  assert.match(comments[0], /Exports `VERSION`/);
});

test("/describe from a reviewed author enqueues a describe job", () => {
  const payload = {
    action: "created",
    installation: { id: 1 },
    repository: { full_name: "gregnazario/example" },
    comment: { id: 99, body: "/describe please", user: { login: "gregnazario" } },
    issue: { number: 7, user: { login: "gregnazario" }, labels: [], pull_request: {} },
  };
  assert.deepEqual(reviewJobFromWebhook("issue_comment", payload, "gregnazario"), {
    key: "gregnazario/example#7",
    fullName: "gregnazario/example",
    number: 7,
    installationId: 1,
    force: false,
    kind: "describe",
    triggerCommentId: 99,
  });
  assert.equal(
    reviewJobFromWebhook(
      "issue_comment",
      { ...payload, comment: { ...payload.comment, user: { login: "stranger" } } },
      "gregnazario",
    ),
    null,
  );
});
