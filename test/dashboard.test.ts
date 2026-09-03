import assert from "node:assert/strict";
import test from "node:test";
import { Dashboard } from "../src/dashboard.ts";

const sample = {
  at: "2026-09-02T15:00:00.000Z",
  repository: "gregnazario/example",
  number: 7,
  head: "abcdef1234",
  status: "reviewed",
  event: "COMMENT",
  severities: { High: 1, Low: 2 } as Record<string, number>,
  durationMs: 42_000,
};

test("dashboard renders recent jobs and metrics, newest first", () => {
  const dashboard = new Dashboard(undefined);
  dashboard.recordJob(sample);
  dashboard.recordJob({ ...sample, number: 8, status: "skipped", severities: {} });
  const html = dashboard.renderHtml(3, "queue_depth 3\n");
  assert.match(html, /example#8<\/a>/);
  assert.match(html, /1 High, 2 Low/);
  assert.match(html, /queue_depth 3/);
  assert.match(html, /42\.0s/);
  const parsed = JSON.parse(dashboard.renderJson(3, "queue_depth 3"));
  assert.equal(parsed.jobs[0].number, 8);
  assert.equal(parsed.queueDepth, 3);
});

test("dashboard keeps only the last 25 jobs", () => {
  const dashboard = new Dashboard(undefined);
  for (let i = 0; i < 30; i += 1) {
    dashboard.recordJob({ ...sample, number: i, severities: {} });
  }
  const parsed = JSON.parse(dashboard.renderJson(0, ""));
  assert.equal(parsed.jobs.length, 25);
  assert.equal(parsed.jobs[0].number, 29);
});

test("dashboard token gates access via query or bearer header", () => {
  const open = new Dashboard(undefined);
  assert.equal(open.authorized({ url: "/dashboard", headers: {} }), true);

  const gated = new Dashboard("s3cret");
  assert.equal(gated.authorized({ url: "/dashboard", headers: {} }), false);
  assert.equal(gated.authorized({ url: "/dashboard?token=wrong", headers: {} }), false);
  assert.equal(gated.authorized({ url: "/dashboard?token=s3cret", headers: {} }), true);
  assert.equal(
    gated.authorized({ url: "/dashboard", headers: { authorization: "Bearer s3cret" } }),
    true,
  );
});

test("dashboard html escapes untrusted values", () => {
  const dashboard = new Dashboard(undefined);
  dashboard.recordJob({
    ...sample,
    repository: 'gre"g/<script>',
    status: "<b>owned</b>",
    severities: {},
  });
  const html = dashboard.renderHtml(0, "");
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<b>owned<\/b>/);
});
