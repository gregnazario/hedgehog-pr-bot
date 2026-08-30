import assert from "node:assert/strict";
import test from "node:test";
import { makeJsonLogger } from "../src/logging.ts";
import { createMetrics } from "../src/metrics.ts";

test("metrics render counters, labels, and gauges", () => {
  const fixed = 1_800_000_000_000;
  const metrics = createMetrics({ depth: () => 3 }, () => fixed);
  metrics.inc("webhook_events_total", { event: "pull_request" });
  metrics.inc("webhook_events_total", { event: "pull_request" });
  metrics.inc("webhook_events_total", { event: "ping" });
  const text = metrics.render();
  assert.match(text, /# TYPE webhook_events_total counter/);
  assert.match(text, /webhook_events_total\{event="pull_request"\} 2/);
  assert.match(text, /webhook_events_total\{event="ping"\} 1/);
  assert.match(text, /process_start_time_seconds 1800000000/);
  assert.match(text, /# TYPE depth gauge\ndepth 3/);
});

test("json logger emits one object per line with level and message", () => {
  const lines: string[] = [];
  const logger = makeJsonLogger((line) => lines.push(line));
  logger.log("Queued", "owner/repo#1", { at: "abc1234" });
  logger.error("boom");
  assert.equal(lines.length, 2);
  const info = JSON.parse(lines[0]);
  assert.equal(info.level, "info");
  assert.equal(info.message, 'Queued owner/repo#1 {"at":"abc1234"}');
  assert.equal(typeof info.time, "string");
  assert.equal(JSON.parse(lines[1]).level, "error");
});
