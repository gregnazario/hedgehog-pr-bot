import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createGitHubAppJwt, GitHubClient } from "../src/github.mjs";

test("creates an RS256 GitHub App JWT with bounded claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const jwt = createGitHubAppJwt({ clientId: "Iv1.test", privateKey, now });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url")), {
    iat: 1_799_999_940,
    exp: 1_800_000_540,
    iss: "Iv1.test",
  });
  assert.equal(
    verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
    true,
  );
});

test("paginates GitHub list responses", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url) => {
    calls.push(url);
    const page = new URL(url).searchParams.get("page");
    const length = page === "1" ? 100 : 2;
    return new Response(JSON.stringify(Array.from({ length }, (_, index) => ({ index }))), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const results = await client.paginatedList("/example");
  assert.equal(results.length, 102);
  assert.equal(calls.length, 2);
});

test("submits a pull request review with inline comments", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 99 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.createPullRequestReview("gregnazario/example", 7, {
    commitId: "abc123",
    body: "summary",
    event: "COMMENT",
    comments: [{ path: "src/app.mjs", line: 4, side: "RIGHT", body: "note" }],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/gregnazario/example/pulls/7/reviews");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    commit_id: "abc123",
    body: "summary",
    event: "COMMENT",
    comments: [{ path: "src/app.mjs", line: 4, side: "RIGHT", body: "note" }],
  });
});

test("omits the comments array when posting a summary-only review", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 99 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.createPullRequestReview("gregnazario/example", 7, {
    commitId: "abc123",
    body: "summary",
    event: "COMMENT",
    comments: [],
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    commit_id: "abc123",
    body: "summary",
    event: "COMMENT",
  });
});

test("posts a single pull request review comment on a line", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 12 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.createPullRequestReviewComment("gregnazario/example", 7, {
    commitId: "abc123",
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: "note",
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/gregnazario/example/pulls/7/comments");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    commit_id: "abc123",
    path: "src/app.mjs",
    body: "note",
    line: 4,
    side: "RIGHT",
  });
});

test("updates a pull request review body", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ id: 44 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.updatePullRequestReview("gregnazario/example", 7, 44, "updated");
  assert.equal(calls[0].url, "https://api.github.com/repos/gregnazario/example/pulls/7/reviews/44");
  assert.equal(calls[0].options.method, "PUT");
  assert.deepEqual(JSON.parse(calls[0].options.body), { body: "updated" });
});
