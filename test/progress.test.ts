import assert from "node:assert/strict";
import test from "node:test";
import { finishProgress, prepareAcceptedJob, startProgress } from "../src/progress.ts";
import type {
  CheckRunUpdate,
  NewCheckRun,
  ProgressClient,
  StartProgressClient,
} from "../src/types.ts";

test("startProgress reuses existing hedgehog eyes and opens an in-progress check", async () => {
  const calls: NewCheckRun[] = [];
  const client: StartProgressClient = {
    listIssueReactions: async () => [
      { id: 3, content: "eyes", user: { login: "hedgehog-pr-bot[bot]" } },
    ],
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
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(progress, { eyesReactionId: 3, checkRunId: 88 });
  assert.equal(calls[0].name, "Pi review");
  assert.equal(calls[0].status, "in_progress");
  assert.equal(calls[0].title, "👀 Reviewing…");
});

test("finishProgress removes eyes and completes the check", async () => {
  const deleted: Array<{ number: number; id: number }> = [];
  let updated: { id: number; payload: CheckRunUpdate } | undefined;
  await finishProgress(
    {
      deleteIssueReaction: async (_repo, number, id) => deleted.push({ number, id }),
      updateCheckRun: async (_repo, id, payload) => (updated = { id, payload }),
    },
    {
      fullName: "gregnazario/example",
      number: 7,
      checkRunId: 88,
      eyesReactionId: 3,
      outcome: { conclusion: "success", title: "✅ No new findings", summary: "No new findings." },
    },
  );
  assert.deepEqual(deleted, [{ number: 7, id: 3 }]);
  assert.ok(updated);
  assert.equal(updated.payload.conclusion, "success");
});

function reviewableClient(overrides: Partial<ProgressClient> = {}): ProgressClient {
  return {
    getPullRequest: async () => ({
      number: 7,
      state: "open",
      draft: false,
      user: { login: "gregnazario" },
      head: { sha: "abc" },
    }),
    listIssueLabels: async () => [],
    listIssueReactions: async () => [],
    createIssueReaction: async () => ({ id: 2 }),
    createCheckRun: async () => ({ id: 1 }),
    listPullRequestReviews: async () => [],
    ...overrides,
  };
}

test("prepareAcceptedJob starts progress for a reviewable PR", async () => {
  const prepared = await prepareAcceptedJob(
    reviewableClient(),
    { fullName: "gregnazario/example", number: 7, force: false },
    { author: "gregnazario", fingerprint: "fp" },
  );
  assert.ok(prepared);
  assert.equal(prepared.headSha, "abc");
  assert.equal(prepared.checkRunId, 1);
  assert.equal(prepared.eyesReactionId, 2);
});

test("prepareAcceptedJob skips already-reviewed heads unless force", async () => {
  let created = false;
  const client = reviewableClient({
    listPullRequestReviews: async () => [
      {
        id: 1,
        state: "APPROVED",
        user: { type: "Bot", login: "hedgehog-pr-bot[bot]" },
        body: "<!-- greg-pr-bot-review head:abc config:fp -->\ndone",
      },
    ],
    createCheckRun: async () => {
      created = true;
      return { id: 1 };
    },
  });
  assert.equal(
    await prepareAcceptedJob(
      client,
      {
        fullName: "gregnazario/example",
        number: 7,
      },
      { author: "gregnazario", fingerprint: "fp" },
    ),
    null,
  );
  assert.equal(created, false);
  const prepared = await prepareAcceptedJob(
    client,
    {
      fullName: "gregnazario/example",
      number: 7,
    },
    { author: "gregnazario", fingerprint: "fp", force: true },
  );
  assert.ok(prepared);
  assert.equal(prepared.checkRunId, 1);
  assert.equal(created, true);
});
