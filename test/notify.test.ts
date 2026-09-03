import assert from "node:assert/strict";
import test from "node:test";
import { notifyReview, severityCounts } from "../src/notify.ts";

test("notifyReview posts the JSON payload and reports success", async () => {
  const seen: any[] = [];
  const ok = await notifyReview(
    "https://hooks.example/xyz",
    {
      type: "review",
      repository: "gregnazario/example",
      pull_request: 7,
      head: "abc123",
      status: "reviewed",
      event: "COMMENT",
      severities: { Low: 1 },
    },
    "json",
    async (url, init) => {
      seen.push({ url, init });
      return new Response("ok", { status: 200 });
    },
  );
  assert.equal(ok, true);
  assert.equal(seen[0].url, "https://hooks.example/xyz");
  const body = JSON.parse(seen[0].init?.body);
  assert.equal(body.type, "review");
  assert.equal(body.severities.Low, 1);
});

test("notifyReview swallows failures and skips empty URLs", async () => {
  assert.equal(
    await notifyReview("", {
      type: "review",
      repository: "r",
      pull_request: 1,
      head: "h",
      status: "reviewed",
      severities: {},
    }),
    false,
  );
  assert.equal(
    await notifyReview(
      "https://hooks.example/xyz",
      {
        type: "review",
        repository: "r",
        pull_request: 1,
        head: "h",
        status: "reviewed",
        severities: {},
      },
      "json",
      async () => {
        throw new Error("network down");
      },
    ),
    false,
  );
});

test("severityCounts tallies severities", () => {
  assert.deepEqual(severityCounts(["High", "Low", "Low", "Critical"]), {
    Critical: 1,
    High: 1,
    Low: 2,
  });
});

test("slack format wraps a readable summary in text", async () => {
  const bodies: any[] = [];
  const ok = await notifyReview(
    "https://hooks.slack.com/x",
    {
      type: "review",
      repository: "gregnazario/example",
      pull_request: 7,
      head: "abcdef1234",
      status: "reviewed",
      event: "COMMENT",
      severities: { High: 1, Low: 2 },
    },
    "slack",
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response("ok", { status: 200 });
    },
  );
  assert.equal(ok, true);
  assert.deepEqual(Object.keys(bodies[0]), ["text"]);
  assert.match(
    bodies[0].text,
    /gregnazario\/example#7 \(abcdef1\): reviewed \(COMMENT\) · 1 High, 2 Low/,
  );
});
