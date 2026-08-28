import { createHmac, timingSafeEqual } from "node:crypto";
import { hasSkipReviewLabel, isReviewCommand } from "./signals.ts";
import type { ReviewJob } from "./types.ts";

const reviewActions = new Set(["opened", "reopened", "ready_for_review", "synchronize"]);

type WebhookLabel = string | { name?: string };

interface WebhookPullRequest {
  draft?: boolean;
  user?: { login?: string };
  head?: { sha?: string };
  labels?: WebhookLabel[];
}

interface PullRequestEvent {
  action?: string;
  number?: number;
  installation?: { id?: number };
  repository?: { full_name?: string };
  pull_request?: WebhookPullRequest;
}

interface IssueCommentEvent {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  comment?: { body?: string; user?: { login?: string } };
  issue?: {
    number?: number;
    user?: { login?: string };
    labels?: WebhookLabel[];
    pull_request?: unknown;
  };
}

export function verifyWebhookSignature(
  secret: string | undefined,
  body: Buffer,
  signature: string | string[] | undefined | null,
): boolean {
  const text = Array.isArray(signature) ? signature[0] : signature;
  if (!secret || !text?.startsWith("sha256=")) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(text);
  return (
    expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

export function reviewJobFromWebhook(
  eventName: string | undefined,
  payload: unknown,
  author: string,
): ReviewJob | null {
  if (eventName === "issue_comment")
    return reviewJobFromComment(payload as IssueCommentEvent, author);
  const event = payload as PullRequestEvent;
  if (eventName !== "pull_request" || !reviewActions.has(event.action ?? "")) return null;
  const pullRequest = event.pull_request;
  const fullName = event.repository?.full_name;
  const installationId = event.installation?.id;
  const number = event.number;
  if (
    !pullRequest ||
    !fullName ||
    !installationId ||
    number === undefined ||
    !Number.isSafeInteger(number)
  )
    return null;
  if (pullRequest.draft || pullRequest.user?.login?.toLowerCase() !== author.toLowerCase())
    return null;
  if (hasSkipReviewLabel(pullRequest.labels)) return null;
  return jobFromPullRequest(fullName, number, installationId, pullRequest, false);
}

function reviewJobFromComment(payload: IssueCommentEvent, author: string): ReviewJob | null {
  if (payload.action !== "created") return null;
  if (!payload.issue?.pull_request) return null;
  if (!isReviewCommand(payload.comment?.body)) return null;
  if (payload.comment?.user?.login?.toLowerCase() !== author.toLowerCase()) return null;
  if (hasSkipReviewLabel(payload.issue.labels)) return null;
  const fullName = payload.repository?.full_name;
  const installationId = payload.installation?.id;
  const number = payload.issue?.number;
  if (!fullName || !installationId || number === undefined || !Number.isSafeInteger(number))
    return null;
  if (payload.issue.user?.login?.toLowerCase() !== author.toLowerCase()) return null;
  return {
    key: `${fullName}#${number}`,
    fullName,
    number,
    installationId,
    force: true,
  };
}

function jobFromPullRequest(
  fullName: string,
  number: number,
  installationId: number,
  pullRequest: WebhookPullRequest,
  force: boolean,
): ReviewJob {
  return {
    key: `${fullName}#${number}`,
    fullName,
    number,
    installationId,
    headSha: pullRequest.head?.sha,
    force,
  };
}
