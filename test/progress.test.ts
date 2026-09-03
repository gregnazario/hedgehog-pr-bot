import assert from "node:assert/strict";
import test from "node:test";
import {
  abandonQueuedProgress,
  cancelQueuedProgress,
  finishProgress,
  prepareAcceptedJob,
  startProgress,
  startQueuedProgress,
  sweepStaleQueuedChecks,
} from "../src/progress.ts";
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

test("startQueuedProgress opens a queued check", async () => {
  const created: NewCheckRun[] = [];
  const client: StartProgressClient = {
    createCheckRun: async (_repo, payload) => {
      created.push(payload);
      return { id: 31 };
    },
  };
  const id = await startQueuedProgress(client, { fullName: "gregnazario/example", headSha: "abc" });
  assert.equal(id, 31);
  assert.equal(created[0].status, "queued");
});

test("startProgress adopts a queued check instead of creating another", async () => {
  const created: NewCheckRun[] = [];
  const updates: CheckRunUpdate[] = [];
  const client: StartProgressClient = {
    listIssueReactions: async () => [],
    createIssueReaction: async () => ({ id: 3 }),
    createCheckRun: async (_repo, payload) => {
      created.push(payload);
      return { id: 12 };
    },
    updateCheckRun: async (_repo, _id, payload) => {
      updates.push(payload);
    },
  };
  const progress = await startProgress(client, {
    fullName: "gregnazario/example",
    number: 7,
    headSha: "abc",
    adoptCheckRunId: 12,
  });
  assert.deepEqual(progress, { eyesReactionId: 3, checkRunId: 12 });
  assert.equal(created.length, 0);
  assert.equal(updates[0].status, "in_progress");
});

test("startProgress falls back to creating when adoption fails", async () => {
  const created: NewCheckRun[] = [];
  const client: StartProgressClient = {
    listIssueReactions: async () => [],
    createIssueReaction: async () => ({ id: 3 }),
    createCheckRun: async (_repo, payload) => {
      created.push(payload);
      return { id: 77 };
    },
    updateCheckRun: async () => {
      throw new Error("gone");
    },
  };
  const progress = await startProgress(client, {
    fullName: "gregnazario/example",
    number: 7,
    headSha: "abc",
    adoptCheckRunId: 12,
    logger: { log() {}, error() {} },
  });
  assert.equal(progress.checkRunId, 77);
  assert.equal(created.length, 1);
});

test("abandonQueuedProgress completes inherited checks as skipped", async () => {
  const updates: CheckRunUpdate[] = [];
  await abandonQueuedProgress(
    { updateCheckRun: async (_repo, _id, payload) => updates.push(payload) },
    { fullName: "gregnazario/example", checkRunId: 5, summary: "The skip-review label is set." },
  );
  assert.equal(updates[0].conclusion, "skipped");
  assert.ok(updates[0].summary);
  assert.match(updates[0].summary, /skip-review/);
});

test("cancelQueuedProgress marks replaced checks cancelled", async () => {
  const updates: CheckRunUpdate[] = [];
  await cancelQueuedProgress(
    { updateCheckRun: async (_repo, _id, payload) => updates.push(payload) },
    { fullName: "gregnazario/example", checkRunId: 5 },
  );
  assert.equal(updates[0].conclusion, "cancelled");
  assert.ok(updates[0].title);
  assert.match(updates[0].title, /Superseded/);
});

test("sweepStaleQueuedChecks completes only old queued checks", async () => {
  const updates: CheckRunUpdate[] = [];
  const now = Date.parse("2026-08-29T12:00:00Z");
  const client: Parameters<typeof sweepStaleQueuedChecks>[0] = {
    listCheckRuns: async () => [
      { id: 1, name: "Pi review", status: "queued", started_at: "2026-08-29T01:00:00Z" },
      { id: 2, name: "Pi review", status: "queued", started_at: "2026-08-29T11:50:00Z" },
      { id: 3, name: "Pi review", status: "completed", started_at: "2026-08-28T01:00:00Z" },
    ],
    updateCheckRun: async (_repo, _id, payload) => updates.push(payload),
  };
  const swept = await sweepStaleQueuedChecks(client, { fullName: "r/e", headSha: "abc", now });
  assert.equal(swept, 1);
  assert.equal(updates.length, 1);
  assert.ok(updates[0].title);
  assert.match(updates[0].title, /Stale queued check/);
});

test("prepareAcceptedJob honors skip: true in .hedgehog.yml", async () => {
  const updates: any[] = [];
  const client = reviewableClient({
    getFileContents: async () => "skip: true\n",
    updateCheckRun: async (_repo, _id, payload) => updates.push(payload),
  });
  const prepared = await prepareAcceptedJob(
    client,
    { fullName: "gregnazario/example", number: 7, checkRunId: 5 },
    { author: "gregnazario", fingerprint: "fp" },
  );
  assert.equal(prepared, null);
  assert.equal(updates[updates.length - 1].conclusion, "skipped");
  assert.match(updates[updates.length - 1].summary, /hedgehog\.yml/);
});

test("prepareAcceptedJob surfaces repo config on accepted jobs", async () => {
  const client = reviewableClient({
    getFileContents: async (_repo, path) =>
      path === ".hedgehog.yml" ? "ignore_paths: [gen]\nmin_severity: Medium\n" : "",
  });
  const prepared = await prepareAcceptedJob(
    client,
    { fullName: "gregnazario/example", number: 7 },
    { author: "gregnazario", fingerprint: "fp", force: true },
  );
  assert.ok(prepared);
  assert.equal(prepared.repoConfig?.minSeverity, "Medium");
  assert.deepEqual(prepared.repoConfig?.ignorePaths, ["gen"]);
});

test("repo models change the marker fingerprint", async () => {
  const client = reviewableClient({
    getFileContents: async () => "models: zai/glm-4.7:low\n",
    listPullRequestReviews: async () => [
      {
        id: 1,
        state: "APPROVED",
        user: { type: "Bot" },
        body: "<!-- greg-pr-bot-review head:abc config:fp -->\ndone",
      },
    ],
  });
  // The server fingerprint "fp" is folded with the repo models, so the old
  // marker no longer matches and the job is accepted.
  const prepared = await prepareAcceptedJob(
    client,
    { fullName: "gregnazario/example", number: 7 },
    { author: "gregnazario", fingerprint: "fp" },
  );
  assert.ok(prepared);
  assert.notEqual(prepared.fingerprint, "fp");
});
