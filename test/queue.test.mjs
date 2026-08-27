import assert from "node:assert/strict";
import test from "node:test";
import { SerialDedupeQueue } from "../src/queue.mjs";

test("keeps only the latest pending job for a PR", async () => {
  const handled = [];
  const queue = new SerialDedupeQueue(async (job) => handled.push(job.revision));
  queue.enqueue({ key: "owner/repo#1", revision: 1 });
  queue.enqueue({ key: "owner/repo#1", revision: 2 });
  queue.enqueue({ key: "owner/repo#2", revision: 1 });
  await queue.onIdle();
  assert.deepEqual(handled, [2, 1]);
});

test("runs one review at a time", async () => {
  let active = 0;
  let maximum = 0;
  const queue = new SerialDedupeQueue(async () => {
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
  const replaced = [];
  const queue = new SerialDedupeQueue(async () => {}, {
    onReplace: (previous, next) => replaced.push([previous.revision, next.revision]),
  });
  queue.enqueue({ key: "owner/repo#1", revision: 1 });
  queue.enqueue({ key: "owner/repo#1", revision: 2 });
  await queue.onIdle();
  assert.deepEqual(replaced, [[1, 2]]);
});
