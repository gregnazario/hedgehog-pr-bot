import assert from "node:assert/strict";
import test from "node:test";
import { cancelQueuedProgress, finishProgress, startProgress } from "../src/progress.mjs";

test("startProgress reuses existing hedgehog eyes and opens an in-progress check", async () => {
  const calls = [];
  const client = {
    listIssueReactions: async () => [{ id: 3, content: "eyes", user: { login: "hedgehog-pr-bot[bot]" } }],
    createIssueReaction: async () => {
      throw new Error("should not create");
    },
    createCheckRun: async (_repo, payload) => {
      calls.push(payload);
      return { id: 88 };
    },
  };
  const progress = await startProgress(client, {
    fullName: "gregnazario/example",
    number: 7,
    headSha: "abc",
    logger: { error() {} },
  });
  assert.deepEqual(progress, { eyesReactionId: 3, checkRunId: 88 });
  assert.equal(calls[0].name, "Pi review");
  assert.equal(calls[0].status, "in_progress");
  assert.equal(calls[0].title, "👀 Reviewing…");
});

test("finishProgress removes eyes and completes the check", async () => {
  const deleted = [];
  let updated;
  await finishProgress({
    deleteIssueReaction: async (_repo, number, id) => deleted.push({ number, id }),
    updateCheckRun: async (_repo, id, payload) => (updated = { id, payload }),
  }, {
    fullName: "gregnazario/example",
    number: 7,
    checkRunId: 88,
    eyesReactionId: 3,
    outcome: { conclusion: "success", title: "✅ No new findings", summary: "No new findings." },
  });
  assert.deepEqual(deleted, [{ number: 7, id: 3 }]);
  assert.equal(updated.payload.conclusion, "success");
});

test("cancelQueuedProgress marks the old check cancelled", async () => {
  let updated;
  await cancelQueuedProgress({
    updateCheckRun: async (_repo, id, payload) => (updated = payload),
  }, { fullName: "gregnazario/example", checkRunId: 12 });
  assert.equal(updated.conclusion, "cancelled");
});
