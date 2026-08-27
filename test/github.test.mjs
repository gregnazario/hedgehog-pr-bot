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

test("creates an eyes reaction and a check run", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 8 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.createIssueReaction("gregnazario/example", 7, "eyes");
  await client.createCheckRun("gregnazario/example", {
    headSha: "abc123",
    name: "Pi review",
    status: "in_progress",
    title: "👀 Reviewing…",
    summary: "Hedgehog is reviewing this pull request.",
  });
  assert.equal(calls[0].url, "https://api.github.com/repos/gregnazario/example/issues/7/reactions");
  assert.deepEqual(calls[0].body, { content: "eyes" });
  assert.equal(calls[1].url, "https://api.github.com/repos/gregnazario/example/check-runs");
  assert.equal(calls[1].body.head_sha, "abc123");
  assert.equal(calls[1].body.name, "Pi review");
  assert.equal(calls[1].body.output.title, "👀 Reviewing…");
});

test("dismisses a review and replies to a thread", async () => {
  const calls = [];
  const client = new GitHubClient("token", async (url, options) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.dismissPullRequestReview("gregnazario/example", 7, 55, "No remaining Critical or High findings.");
  await client.createPullRequestReviewCommentReply("gregnazario/example", 7, 90, "Still applies.");
  assert.match(calls[0].url, /reviews\/55\/dismissals$/);
  assert.deepEqual(calls[0].body, { message: "No remaining Critical or High findings.", event: "DISMISS" });
  assert.match(calls[1].url, /comments\/90\/replies$/);
  assert.deepEqual(calls[1].body, { body: "Still applies." });
});

test("lists unresolved hedgehog threads and ignores other bots", async () => {
  let query;
  const client = new GitHubClient("token", async (_url, options) => {
    query = JSON.parse(options.body).query;
    return new Response(JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "T1",
                  isResolved: false,
                  comments: {
                    nodes: [{
                      databaseId: 101,
                      body: "**High:** leak",
                      path: "a.mjs",
                      line: 4,
                      side: "RIGHT",
                      author: { login: "hedgehog-pr-bot[bot]" },
                    }],
                  },
                  recentComments: {
                    nodes: [{
                      body: "**High:** leak",
                      author: { login: "hedgehog-pr-bot[bot]" },
                    }],
                  },
                },
                {
                  id: "T2",
                  isResolved: false,
                  comments: {
                    nodes: [{
                      databaseId: 202,
                      body: "unrelated",
                      path: "b.mjs",
                      line: 1,
                      side: "RIGHT",
                      author: { login: "cursor[bot]" },
                    }],
                  },
                  recentComments: { nodes: [] },
                },
                {
                  id: "T3",
                  isResolved: true,
                  comments: {
                    nodes: [{
                      databaseId: 303,
                      body: "**Low:** fixed",
                      path: "c.mjs",
                      line: 1,
                      side: "RIGHT",
                      author: { login: "hedgehog-pr-bot[bot]" },
                    }],
                  },
                  recentComments: { nodes: [] },
                },
                {
                  id: "T4",
                  isResolved: false,
                  comments: {
                    nodes: [{
                      databaseId: 404,
                      body: "**Low:** still",
                      path: "d.mjs",
                      line: 2,
                      side: "RIGHT",
                      author: { login: "hedgehog-pr-bot[bot]" },
                    }],
                  },
                  recentComments: {
                    nodes: [
                      {
                        body: "**Low:** still",
                        author: { login: "hedgehog-pr-bot[bot]" },
                      },
                      {
                        body: "Still applies.",
                        author: { login: "hedgehog-pr-bot[bot]" },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const threads = await client.listUnresolvedHedgehogThreads("gregnazario/example", 7);
  assert.match(query, /recentComments: comments\(last: 20\)/);
  assert.deepEqual(threads, [{
    commentId: 101,
    threadId: "T1",
    path: "a.mjs",
    line: 4,
    side: "RIGHT",
    severity: "High",
    body: "**High:** leak",
    alreadyReplied: false,
  }, {
    commentId: 404,
    threadId: "T4",
    path: "d.mjs",
    line: 2,
    side: "RIGHT",
    severity: "Low",
    body: "**Low:** still",
    alreadyReplied: true,
  }]);
});
