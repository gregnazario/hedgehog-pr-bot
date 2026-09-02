import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";
import { createGitHubAppJwt, GitHubClient } from "../src/github.ts";

test("creates an RS256 GitHub App JWT with bounded claims", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = 1_800_000_000_000;
  const jwt = createGitHubAppJwt({ clientId: "Iv1.test", privateKey, now });
  const [header, payload, signature] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString("utf8")), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), {
    iat: 1_799_999_940,
    exp: 1_800_000_540,
    iss: "Iv1.test",
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
});

test("paginates GitHub list responses", async () => {
  const calls: any[] = [];
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
  const calls: any[] = [];
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
  const calls: any[] = [];
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
  const calls: any[] = [];
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
  const calls: any[] = [];
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
  const calls: any[] = [];
  const client = new GitHubClient("token", async (url, options = {}) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body as string) });
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
  const calls: any[] = [];
  const client = new GitHubClient("token", async (url, options = {}) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body as string) });
    return new Response(JSON.stringify({ id: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  await client.dismissPullRequestReview(
    "gregnazario/example",
    7,
    55,
    "No remaining Critical or High findings.",
  );
  await client.createPullRequestReviewCommentReply("gregnazario/example", 7, 90, "Still applies.");
  assert.match(calls[0].url, /reviews\/55\/dismissals$/);
  assert.deepEqual(calls[0].body, {
    message: "No remaining Critical or High findings.",
    event: "DISMISS",
  });
  assert.match(calls[1].url, /comments\/90\/replies$/);
  assert.deepEqual(calls[1].body, { body: "Still applies." });
});

test("lists unresolved hedgehog threads and ignores other bots", async () => {
  let query = "";
  const client = new GitHubClient("token", async (_url, options = {}) => {
    query = JSON.parse(options.body as string).query;
    return new Response(
      JSON.stringify({
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
                      nodes: [
                        {
                          databaseId: 101,
                          body: "**High:** leak",
                          path: "a.mjs",
                          line: 4,
                          side: "RIGHT",
                          author: { login: "hedgehog-pr-bot[bot]" },
                        },
                      ],
                    },
                    recentComments: {
                      nodes: [
                        {
                          body: "**High:** leak",
                          author: { login: "hedgehog-pr-bot[bot]" },
                        },
                      ],
                    },
                  },
                  {
                    id: "T5",
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: 505,
                          body: "**Low:** deleted line note",
                          path: "e.mjs",
                          line: null,
                          originalLine: 7,
                          author: { login: "hedgehog-pr-bot[bot]" },
                        },
                      ],
                    },
                    recentComments: { nodes: [] },
                  },
                  {
                    id: "T2",
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: 202,
                          body: "unrelated",
                          path: "b.mjs",
                          line: 1,
                          side: "RIGHT",
                          author: { login: "cursor[bot]" },
                        },
                      ],
                    },
                    recentComments: { nodes: [] },
                  },
                  {
                    id: "T3",
                    isResolved: true,
                    comments: {
                      nodes: [
                        {
                          databaseId: 303,
                          body: "**Low:** fixed",
                          path: "c.mjs",
                          line: 1,
                          side: "RIGHT",
                          author: { login: "hedgehog-pr-bot[bot]" },
                        },
                      ],
                    },
                    recentComments: { nodes: [] },
                  },
                  {
                    id: "T4",
                    isResolved: false,
                    comments: {
                      nodes: [
                        {
                          databaseId: 404,
                          body: "**Low:** still",
                          path: "d.mjs",
                          line: 2,
                          side: "RIGHT",
                          author: { login: "hedgehog-pr-bot[bot]" },
                        },
                      ],
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
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const threads = await client.listUnresolvedHedgehogThreads("gregnazario/example", 7);
  assert.match(query, /recentComments: comments\(last: 20\)/);
  assert.deepEqual(threads, [
    {
      commentId: 101,
      threadId: "T1",
      path: "a.mjs",
      line: 4,
      side: "RIGHT",
      severity: "High",
      body: "**High:** leak",
      alreadyReplied: false,
    },
    {
      commentId: 505,
      threadId: "T5",
      path: "e.mjs",
      line: 7,
      side: "LEFT",
      severity: "Low",
      body: "**Low:** deleted line note",
      alreadyReplied: false,
    },
    {
      commentId: 404,
      threadId: "T4",
      path: "d.mjs",
      line: 2,
      side: "RIGHT",
      severity: "Low",
      body: "**Low:** still",
      alreadyReplied: true,
    },
  ]);
});

test("listUnresolvedHedgehogThreads honors a custom bot login", async () => {
  const client = new GitHubClient(
    "token",
    async () => {
      return new Response(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: "T9",
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            databaseId: 707,
                            body: "**High:** leak",
                            path: "a.ts",
                            line: 3,
                            side: "RIGHT",
                            author: { login: "my-reviewer[bot]" },
                          },
                        ],
                      },
                      recentComments: { nodes: [] },
                    },
                  ],
                },
              },
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
    "my-reviewer",
  );
  const threads = await client.listUnresolvedHedgehogThreads("gregnazario/example", 7);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].commentId, 707);
});

test("getPullRequestDiff falls back to per-file patches past 300 files", async () => {
  const calls: string[] = [];
  const client = new GitHubClient("token", async (url, options = {}) => {
    const headers = options.headers as Record<string, string> | undefined;
    calls.push(`${options.method ?? "GET"} ${url} ${headers?.Accept ?? ""}`);
    if (url.endsWith("/pulls/7")) {
      return new Response(
        JSON.stringify({
          message: "Sorry, the diff exceeded the maximum number of files (300).",
          errors: [{ resource: "PullRequest", field: "diff", code: "too_large" }],
        }),
        { status: 406, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify([
        {
          filename: "src/app.mjs",
          status: "modified",
          patch: "@@ -1,1 +1,2 @@\n ctx\n+added",
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const diff = await client.getPullRequestDiff("gregnazario/example", 7);
  assert.match(diff, /diff --git a\/src\/app\.mjs b\/src\/app\.mjs/);
  assert.match(diff, /\+added/);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /application\/vnd\.github\.diff/);
  assert.match(calls[1], /\/pulls\/7\/files/);
});

test("retries transient 5xx and 429 responses before failing", async () => {
  const statuses: number[] = [];
  const flaky = async () => {
    statuses.push(500);
    if (statuses.length < 2) {
      return new Response("server error", { status: 500, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify([{ ok: true }]), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const recovered = await new GitHubClient("token", flaky).request("/example");
  assert.equal((recovered as any[]).length, 1);
  assert.equal(statuses.length, 2);

  let throttled = 0;
  const always = async () => {
    throttled += 1;
    return new Response("nope", { status: 429, headers: { "retry-after": "0" } });
  };
  await assert.rejects(
    () => new GitHubClient("token", always).request("/example"),
    /GitHub returned 429/,
  );
  assert.equal(throttled, 3);
});

test("does not retry non-transient statuses", async () => {
  let calls = 0;
  const client = new GitHubClient("token", async () => {
    calls += 1;
    return new Response("missing", { status: 404 });
  });
  await assert.rejects(() => client.request("/example"), /GitHub returned 404/);
  assert.equal(calls, 1);
});
