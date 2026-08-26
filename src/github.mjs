import { sign } from "node:crypto";

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
}

function githubHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "greg-pr-bot",
    "X-GitHub-Api-Version": apiVersion,
  };
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
