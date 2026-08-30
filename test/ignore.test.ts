import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyIgnoreJob } from "../src/ignore.ts";
import { findingFingerprint } from "../src/memory.ts";
import type { ReviewJob } from "../src/types.ts";

function job(overrides: Partial<ReviewJob> = {}): ReviewJob {
  return {
    key: "gregnazario/example#7",
    fullName: "gregnazario/example",
    number: 7,
    installationId: 1,
    force: false,
    kind: "ignore",
    replyToCommentId: 501,
    triggerCommentId: 602,
    ...overrides,
  };
}

test("/ignore stores the fingerprint, resolves the thread, and acks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hedgehog-ignore-"));
  const memoryPath = join(dir, "ignores.json");
  const reactions: Array<[number, string]> = [];
  const resolved: string[] = [];
  const client = {
    getReviewComment: async (_repo: string, commentId: number) => ({
      id: commentId,
      path: "src/app.mjs",
      body: "**High:** The cache is never cleared.",
      user: { login: "hedgehog-pr-bot[bot]" },
    }),
    listUnresolvedHedgehogThreads: async () => [
      { commentId: 501, threadId: "T501" },
      { commentId: 502, threadId: "T502" },
    ],
    resolveReviewThread: async (threadId: string) => resolved.push(threadId),
    reactToReviewComment: async (_repo: string, commentId: number, content: string) => {
      reactions.push([commentId, content]);
    },
  };
  await applyIgnoreJob(client, job(), { botLogin: "hedgehog-pr-bot", memoryPath });
  assert.deepEqual(resolved, ["T501"]);
  assert.deepEqual(reactions, [[602, "+1"]]);
  const stored = await import("../src/memory.ts").then((m) => m.loadIgnoreMemory(memoryPath));
  assert.equal(
    stored.has(findingFingerprint({ path: "src/app.mjs", body: "the cache is never cleared." })),
    true,
  );
});

test("/ignore ignores replies under other bots' comments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hedgehog-ignore-"));
  const memoryPath = join(dir, "ignores.json");
  const client = {
    getReviewComment: async () => ({
      id: 501,
      path: "src/app.mjs",
      body: "**High:** not hedgehog",
      user: { login: "cursor[bot]" },
    }),
  };
  await applyIgnoreJob(client, job(), { botLogin: "hedgehog-pr-bot", memoryPath });
  const stored = await import("../src/memory.ts").then((m) => m.loadIgnoreMemory(memoryPath));
  assert.equal(stored.size, 0);
});

test("/ignore without a memory path stores nothing", async () => {
  const client = {
    getReviewComment: async () => ({
      id: 501,
      path: "src/app.mjs",
      body: "**High:** The cache is never cleared.",
      user: { login: "hedgehog-pr-bot[bot]" },
    }),
  };
  await applyIgnoreJob(client, job(), { botLogin: "hedgehog-pr-bot", memoryPath: "" });
});
