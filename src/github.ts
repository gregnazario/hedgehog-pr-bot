import { type KeyObject, sign } from "node:crypto";
import {
  DEFAULT_BOT_LOGIN,
  isHedgehogLogin,
  parseSeverityPrefix,
  STILL_APPLIES_REPLY,
} from "./signals.ts";
import type {
  CheckRunUpdate,
  FetchLike,
  GitHubLabel,
  GitHubUser,
  HedgehogThread,
  InlineComment,
  IssueReaction,
  NewCheckRun,
  PullRequest,
  PullRequestReview,
  ReviewEvent,
  Side,
  TokenProvider,
} from "./types.ts";

const apiVersion = "2022-11-28";

export function createGitHubAppJwt({
  clientId,
  privateKey,
  now = Date.now(),
}: {
  clientId?: string;
  privateKey: string | KeyObject;
  now?: number;
}): string {
  if (!clientId) throw new Error("APP_CLIENT_ID is required");
  if (!privateKey) throw new Error("A GitHub App private key is required");

  const seconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: seconds - 60,
      exp: seconds + 9 * 60,
      iss: clientId,
    }),
  );
  const unsigned = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export class InstallationTokenProvider implements TokenProvider {
  private readonly clientId: string | undefined;
  private readonly privateKey: string | KeyObject;
  private readonly fetchImpl: FetchLike;
  private readonly cache = new Map<number, { token: string; expiresAt: number }>();

  constructor({
    clientId,
    privateKey,
    fetchImpl = globalThis.fetch,
  }: {
    clientId?: string;
    privateKey: string | KeyObject;
    fetchImpl?: FetchLike;
  }) {
    this.clientId = clientId;
    this.privateKey = privateKey;
    this.fetchImpl = fetchImpl;
  }

  async get(installationId: number): Promise<string> {
    const cached = this.cache.get(installationId);
    if (cached && cached.expiresAt > Date.now() + 5 * 60_000) return cached.token;

    const jwt = createGitHubAppJwt({ clientId: this.clientId, privateKey: this.privateKey });
    const response = await this.fetchImpl(
      `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
      { method: "POST", headers: githubHeaders(jwt) },
    );
    if (!response.ok) throw await githubError(response, "Could not create an installation token");

    const body = (await response.json()) as { token?: string; expires_at?: string };
    const expiresAt = Date.parse(body.expires_at ?? "");
    if (!body.token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub returned an invalid installation token response");
    }
    this.cache.set(installationId, { token: body.token, expiresAt });
    return body.token;
  }
}

interface RequestOptions {
  method?: string;
  accept?: string;
  body?: unknown;
  responseType?: "json" | "text";
}

export class GitHubClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  private readonly botLogin: string;

  constructor(
    token: string,
    fetchImpl: FetchLike = globalThis.fetch,
    botLogin = DEFAULT_BOT_LOGIN,
  ) {
    if (!token) throw new Error("A GitHub token is required");
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.botLogin = botLogin;
  }

  async request<T = unknown>(
    route: string,
    { method = "GET", accept, body, responseType = "json" }: RequestOptions = {},
  ): Promise<T> {
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
    if (responseType === "text") return (await response.text()) as unknown as T;
    if (response.status === 204) return null as T;
    return (await response.json()) as T;
  }

  async paginatedList<T = Record<string, unknown>>(route: string): Promise<T[]> {
    const separator = route.includes("?") ? "&" : "?";
    const results: T[] = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request<T[]>(`${route}${separator}per_page=100&page=${page}`);
      if (!Array.isArray(batch)) throw new Error(`Expected an array from ${route}`);
      results.push(...batch);
      if (batch.length < 100) return results;
    }
  }

  async listInstallationRepositories(): Promise<Array<{ full_name: string }>> {
    const repositories: Array<{ full_name: string }> = [];
    for (let page = 1; ; page += 1) {
      const body = await this.request<{ repositories?: Array<{ full_name: string }> }>(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      const batch = body.repositories ?? [];
      repositories.push(...batch);
      if (batch.length < 100) return repositories;
    }
  }

  listOpenPullRequests(fullName: string): Promise<PullRequest[]> {
    return this.paginatedList<PullRequest>(`/repos/${repoPath(fullName)}/pulls?state=open`);
  }

  getPullRequest(fullName: string, number: number): Promise<PullRequest> {
    return this.request<PullRequest>(`/repos/${repoPath(fullName)}/pulls/${number}`);
  }

  listIssueComments(
    fullName: string,
    number: number,
  ): Promise<Array<{ id: number; user?: GitHubUser; body?: string }>> {
    return this.paginatedList(`/repos/${repoPath(fullName)}/issues/${number}/comments`);
  }

  getPullRequestDiff(fullName: string, number: number): Promise<string> {
    return this.request<string>(`/repos/${repoPath(fullName)}/pulls/${number}`, {
      accept: "application/vnd.github.diff",
      responseType: "text",
    });
  }

  listPullRequestReviews(fullName: string, number: number): Promise<PullRequestReview[]> {
    return this.paginatedList<PullRequestReview>(
      `/repos/${repoPath(fullName)}/pulls/${number}/reviews`,
    );
  }

  createPullRequestReview(
    fullName: string,
    number: number,
    {
      commitId,
      body,
      event = "COMMENT",
      comments,
    }: { commitId?: string; body?: string; event?: ReviewEvent; comments?: InlineComment[] } = {},
  ): Promise<{ id: number } | null> {
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

  createPullRequestReviewComment(
    fullName: string,
    number: number,
    {
      commitId,
      path,
      body,
      line,
      side,
      start_line,
      start_side,
    }: {
      commitId?: string;
      path?: string;
      body?: string;
      line?: number;
      side?: Side;
      start_line?: number;
      start_side?: Side;
    } = {},
  ): Promise<unknown> {
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

  updatePullRequestReview(
    fullName: string,
    number: number,
    reviewId: number,
    body: string,
  ): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/pulls/${number}/reviews/${reviewId}`, {
      method: "PUT",
      body: { body },
    });
  }

  createIssueComment(fullName: string, number: number, body: string): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/comments`, {
      method: "POST",
      body: { body },
    });
  }

  updateIssueComment(fullName: string, commentId: number, body: string): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/issues/comments/${commentId}`, {
      method: "PATCH",
      body: { body },
    });
  }

  deleteIssueComment(fullName: string, commentId: number): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/issues/comments/${commentId}`, {
      method: "DELETE",
    });
  }

  listIssueLabels(fullName: string, number: number): Promise<GitHubLabel[]> {
    return this.paginatedList<GitHubLabel>(`/repos/${repoPath(fullName)}/issues/${number}/labels`);
  }

  listIssueReactions(fullName: string, number: number): Promise<IssueReaction[]> {
    return this.paginatedList<IssueReaction>(
      `/repos/${repoPath(fullName)}/issues/${number}/reactions`,
    );
  }

  reactToIssueComment(fullName: string, commentId: number, content: string): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/issues/comments/${commentId}/reactions`, {
      method: "POST",
      body: { content },
    });
  }

  createIssueReaction(
    fullName: string,
    number: number,
    content: string,
  ): Promise<{ id: number } | null> {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/reactions`, {
      method: "POST",
      body: { content },
    });
  }

  deleteIssueReaction(fullName: string, number: number, reactionId: number): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/issues/${number}/reactions/${reactionId}`, {
      method: "DELETE",
    });
  }

  createCheckRun(fullName: string, payload: NewCheckRun): Promise<{ id: number } | null> {
    return this.request(`/repos/${repoPath(fullName)}/check-runs`, {
      method: "POST",
      body: {
        name: payload.name,
        head_sha: payload.headSha,
        status: payload.status,
        output: { title: payload.title, summary: payload.summary },
      },
    });
  }

  updateCheckRun(fullName: string, checkRunId: number, payload: CheckRunUpdate): Promise<unknown> {
    return this.request(`/repos/${repoPath(fullName)}/check-runs/${checkRunId}`, {
      method: "PATCH",
      body: {
        ...(payload.status ? { status: payload.status } : {}),
        ...(payload.conclusion ? { conclusion: payload.conclusion } : {}),
        ...(payload.title === undefined && payload.summary === undefined
          ? {}
          : { output: { title: payload.title, summary: payload.summary } }),
      },
    });
  }

  dismissPullRequestReview(
    fullName: string,
    number: number,
    reviewId: number,
    message: string,
  ): Promise<unknown> {
    return this.request(
      `/repos/${repoPath(fullName)}/pulls/${number}/reviews/${reviewId}/dismissals`,
      {
        method: "PUT",
        body: { message, event: "DISMISS" },
      },
    );
  }

  createPullRequestReviewCommentReply(
    fullName: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<unknown> {
    return this.request(
      `/repos/${repoPath(fullName)}/pulls/${number}/comments/${commentId}/replies`,
      {
        method: "POST",
        body: { body },
      },
    );
  }

  async graphql<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T | undefined> {
    const payload = await this.request<GraphQLResponse<T> | null>("/graphql", {
      method: "POST",
      body: { query, variables },
    });
    if (payload?.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join("; "));
    }
    return payload?.data;
  }

  async listUnresolvedHedgehogThreads(fullName: string, number: number): Promise<HedgehogThread[]> {
    const [owner, name] = fullName.split("/");
    const threads: HedgehogThread[] = [];
    let cursor: string | null = null;
    while (threads.length < 100) {
      const data: ReviewThreadsData | undefined = await this.graphql<ReviewThreadsData>(
        reviewThreadsQuery,
        {
          owner,
          name,
          number,
          cursor,
        },
      );
      const connection: ReviewThreadsConnection | undefined =
        data?.repository?.pullRequest?.reviewThreads;
      for (const node of connection?.nodes ?? []) {
        if (node.isResolved) continue;
        const comment = node.comments?.nodes?.[0];
        if (!comment || !isHedgehogLogin(comment.author?.login, this.botLogin)) continue;
        threads.push({
          commentId: comment.databaseId,
          threadId: node.id,
          path: comment.path,
          line: comment.line ?? comment.originalLine ?? 0,
          side: comment.side === "LEFT" ? "LEFT" : "RIGHT",
          severity: parseSeverityPrefix(comment.body),
          body: comment.body,
          alreadyReplied: hasStillAppliesReply(node.recentComments?.nodes, this.botLogin),
        });
        if (threads.length >= 100) break;
      }
      if (!connection?.pageInfo?.hasNextPage || threads.length >= 100) break;
      cursor = connection.pageInfo.endCursor ?? null;
    }
    return threads;
  }

  resolveReviewThread(threadId: string): Promise<unknown> {
    return this.graphql(
      `mutation ResolveHedgehogThread($id: ID!) {
        resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
      }`,
      { id: threadId },
    );
  }
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

interface ReviewThreadsConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: ReviewThreadNode[];
}

interface ReviewThreadsData {
  repository?: {
    pullRequest?: {
      reviewThreads?: ReviewThreadsConnection;
    };
  };
}

interface ReviewThreadNode {
  id: string;
  isResolved?: boolean;
  comments?: { nodes?: ThreadCommentNode[] };
  recentComments?: { nodes?: { body?: string; author?: { login?: string } }[] };
}

interface ThreadCommentNode {
  databaseId: number;
  body: string;
  path: string;
  line?: number | null;
  originalLine?: number | null;
  side?: string | null;
  author?: { login?: string };
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "hedgehog-pr-bot",
    "X-GitHub-Api-Version": apiVersion,
  };
}

function hasStillAppliesReply(
  comments: { body?: string; author?: { login?: string } }[] | undefined,
  botLogin: string,
): boolean {
  return (comments ?? []).some(
    (comment) =>
      isHedgehogLogin(comment.author?.login, botLogin) &&
      String(comment.body ?? "").trim() === STILL_APPLIES_REPLY,
  );
}

function repoPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || parts.some((part) => !part))
    throw new Error(`Invalid repository name: ${fullName}`);
  return parts.map(encodeURIComponent).join("/");
}

function base64url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

async function githubError(response: Response, prefix: string): Promise<Error> {
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
