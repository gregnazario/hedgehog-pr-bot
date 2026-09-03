import assert from "node:assert/strict";
import test from "node:test";
import { SerialDedupeQueue } from "../src/queue.ts";

test("keeps only the latest pending job for a PR", async () => {
  const handled: number[] = [];
  const queue = new SerialDedupeQueue<{ key: string; revision: number }>(async (job) => {
    handled.push(job.revision);
  });
  queue.enqueue({ key: "owner/repo#1", revision: 1 });
  queue.enqueue({ key: "owner/repo#1", revision: 2 });
  queue.enqueue({ key: "owner/repo#2", revision: 1 });
  await queue.onIdle();
  assert.deepEqual(handled, [2, 1]);
});

test("runs one review at a time", async () => {
  let active = 0;
  let maximum = 0;
  const queue = new SerialDedupeQueue<{ key: string }>(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
  });
  queue.enqueue({ key: "one" });
  queue.enqueue({ key: "two" });
  await queue.onIdle();
  assert.equal(maximum, 1);
});

test("notifies when a pending job is replaced", async () => {
  const replaced: Array<[number, number]> = [];
  const queue = new SerialDedupeQueue<{ key: string; revision: number }>(async () => {}, {
    onReplace: (previous, next) => replaced.push([previous.revision, next.revision]),
  });
  queue.enqueue({ key: "owner/repo#1", revision: 1 });
  queue.enqueue({ key: "owner/repo#1", revision: 2 });
  await queue.onIdle();
  assert.deepEqual(replaced, [[1, 2]]);
});

test("review and command jobs with different key suffixes coexist", async () => {
  const handled: string[] = [];
  const queue = new SerialDedupeQueue<{ key: string; kind: string }>(async (job) => {
    handled.push(job.key);
  });
  queue.enqueue({ key: "owner/repo#1", kind: "review" });
  queue.enqueue({ key: "owner/repo#1#describe", kind: "describe" });
  queue.enqueue({ key: "owner/repo#1", kind: "review" });
  await queue.onIdle();
  // The newest review replaces the first; the describe survives.
  assert.equal(handled.length, 2);
  assert.ok(handled.includes("owner/repo#1#describe"));
  assert.ok(handled.includes("owner/repo#1"));
});
