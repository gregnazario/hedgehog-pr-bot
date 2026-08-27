import { sign } from "node:crypto";
import { STILL_APPLIES_REPLY, isHedgehogLogin, parseSeverityPrefix } from "./signals.mjs";

const apiVersion = "2022-11-28";

export function createGitHubAppJwt({ clientId, privateKey, now = Date.now() }) {
  if (!clientId) throw new Error("APP_CLIENT_ID is required");
  if (!privateKey) throw new Error("A GitHub App private key is required");

  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: clientId,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export class InstallationTokenProvider {
  constructor({ clientId, privateKey, fetchImpl = globalThis.fetch }) {
    this.clientId = clientId;
    this.privateKey = privateKey;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
  }

  async get(installationId) {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

    const jwt = createGitHubAppJwt({ clientId: this.clientId, privateKey: this.privateKey });
    const response = await this.fetchImpl(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: "POST", headers: githubHeaders(jwt) },
    );
    if (!response.ok) throw await githubError(response, "Could not create an installation token");

    const body = await response.json();
    const expiresAt = Date.parse(body.expires_at);
    if (!body.token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub returned an invalid installation token response");
    }
    this.cache.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }
}

export class GitHubClient {
  constructor(token, fetchImpl = globalThis.fetch) {
    if (!token) throw new Error("A GitHub token is required");
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request(route, { method = "GET", accept, body, responseType = "json" } = {}) {
    const response = await this.fetchImpl(`https://api.github.com${route}`, {
      method,
      headers: {
        ...githubHeaders(this.token),
        ...(accept ? { Accept: accept } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw await githubError(response, `${method} ${route} failed`);
    if (responseType === "text") return response.text();
    if (response.status === 204) return null;
    return response.json();
  }

  async paginatedList(route) {
    const separator = route.includes("?") ? "&" : "?";
    const results = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(`${route}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Expected an array from ${route}`);
      results.push(...batch);
      if (batch.length < 100) return results;
    }
  }

  async listInstallationRepositories() {
    const repositories = [];
    for (let page = 1; ; page += 1) {
      const body = await this.request(`/installation/repositories?per_page=100&page=${page}`);
      const batch = body.repositories ?? [];
      repositories.push(...batch);
      if (batch.length < 100) return repositories;
    }
  }

  listOpenPullRequests(fullName) {
    return this.paginatedList(`/repos/${repoPath(fullName)}/pulls?state=open`);
  }

  getPullRequest(fullName, number) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}`);
  }

  listIssueComments(fullName, number) {
    return this.paginatedList(`/repos/${repoPath(fullName)}/issues/${number}/comments`);
  }

  getPullRequestDiff(fullName, number) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}`, {
      accept: "application/vnd.github.diff",
      responseType: "text",
    });
  }

  listPullRequestReviews(fullName, number) {
    return this.paginatedList(`/repos/${repoPath(fullName)}/pulls/${number}/reviews`);
  }

  createPullRequestReview(fullName, number, { commitId, body, event = "COMMENT", comments } = {}) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/reviews`, {
      method: "POST",
      body: {
        commit_id: commitId,
        body,
        event,
        ...(comments?.length ? { comments } : {}),
      },
    });
  }

  createPullRequestReviewComment(fullName, number, { commitId, path, body, line, side, start_line, start_side } = {}) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/comments`, {
      method: "POST",
      body: {
        commit_id: commitId,
        path,
        body,
        line,
        side,
        ...(start_line ? { start_line, start_side: start_side || side } : {}),
      },
    });
  }

  updatePullRequestReview(fullName, number, reviewId, body) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/reviews/${reviewId}`, {
      method: "PUT",
      body: { body },
    });
  }

  createIssueComment(fullName, number, body) {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/comments`, {
      method: "POST",
      body: { body },
    });
  }

  updateIssueComment(fullName, commentId, body) {
    return this.request(`/repos/${repoPath(fullName)}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: { body },
    });
  }

  deleteIssueComment(fullName, commentId) {
    return this.request(`/repos/${repoPath(fullName)}/issues/comments/${commentId}`, {
      method: "DELETE",
    });
  }

  listIssueLabels(fullName, number) {
    return this.paginatedList(`/repos/${repoPath(fullName)}/issues/${number}/labels`);
  }

  listIssueReactions(fullName, number) {
    return this.paginatedList(`/repos/${repoPath(fullName)}/issues/${number}/reactions`);
  }

  createIssueReaction(fullName, number, content) {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/reactions`, {
      method: "POST",
      body: { content },
    });
  }

  deleteIssueReaction(fullName, number, reactionId) {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/reactions/${reactionId}`, {
      method: "DELETE",
    });
  }

  createCheckRun(fullName, { headSha, name, status, title, summary }) {
    return this.request(`/repos/${repoPath(fullName)}/check-runs`, {
      method: "POST",
      body: {
        name,
        head_sha: headSha,
        status,
        output: { title, summary },
      },
    });
  }

  updateCheckRun(fullName, checkRunId, { status, conclusion, title, summary }) {
    return this.request(`/repos/${repoPath(fullName)}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: {
        ...(status ? { status } : {}),
        ...(conclusion ? { conclusion } : {}),
        ...(title === undefined && summary === undefined ? {} : { output: { title, summary } }),
      },
    });
  }

  dismissPullRequestReview(fullName, number, reviewId, message) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/reviews/${reviewId}/dismissals`, {
      method: "PUT",
      body: { message, event: "DISMISS" },
    });
  }

  createPullRequestReviewCommentReply(fullName, number, commentId, body) {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/comments/${commentId}/replies`, {
      method: "POST",
      body: { body },
    });
  }

  async graphql(query, variables = {}) {
    const payload = await this.request("/graphql", {
      method: "POST",
      body: { query, variables },
    });
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    return payload.data;
  }

  async listUnresolvedHedgehogThreads(fullName, number) {
    const [owner, name] = fullName.split("/");
    const threads = [];
    let cursor = null;
    while (threads.length < 100) {
      const data = await this.graphql(reviewThreadsQuery, {
        owner,
        name,
        number,
        cursor,
      });
      const connection = data?.repository?.pullRequest?.reviewThreads;
      for (const node of connection?.nodes ?? []) {
        if (node.isResolved) continue;
        const comment = node.comments?.nodes?.[0];
        if (!comment || !isHedgehogLogin(comment.author?.login)) continue;
        threads.push({
          commentId: comment.databaseId,
          threadId: node.id,
          path: comment.path,
          line: comment.line ?? comment.originalLine,
          side: comment.side === "LEFT" ? "LEFT" : "RIGHT",
          severity: parseSeverityPrefix(comment.body),
          body: comment.body,
          alreadyReplied: hasStillAppliesReply(node.recentComments?.nodes),
        });
        if (threads.length >= 100) break;
      }
      if (!connection?.pageInfo?.hasNextPage || threads.length >= 100) break;
      cursor = connection.pageInfo.endCursor;
    }
    return threads;
  }

  resolveReviewThread(threadId) {
    return this.graphql(
      `mutation ResolveHedgehogThread($id: ID!) {
        resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
      }`,
      { id: threadId },
    );
  }
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "greg-pr-bot",
    "X-GitHub-Api-Version": apiVersion,
  };
}

function hasStillAppliesReply(comments) {
  return (comments ?? []).some((comment) => (
    isHedgehogLogin(comment.author?.login) && String(comment.body ?? "").trim() === STILL_APPLIES_REPLY
  ));
}

function repoPath(fullName) {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`Invalid repository name: ${fullName}`);
  return parts.map(encodeURIComponent).join("/");
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

async function githubError(response, prefix) {
  const detail = (await response.text()).slice(0, 2_000).trim();
  return new Error(`${prefix}: GitHub returned ${response.status}${detail ? `: ${detail}` : ""}`);
}

const reviewThreadsQuery = `
query HedgehogReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 1) {
            nodes {
              databaseId
              body
              path
              line
              originalLine
              side
              author { login }
            }
          }
          recentComments: comments(last: 20) {
            nodes {
              body
              author { login }
            }
          }
        }
      }
    }
  }
}
`;
