import { createHmac, timingSafeEqual } from "node:crypto";
import {
  hasSkipReviewLabel,
  isDescribeCommand,
  isIgnoreCommand,
  isReviewCommand,
  isReviewedAuthor,
} from "./signals.ts";
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
  comment?: { id?: number; body?: string; user?: { login?: string } };
  issue?: {
    number?: number;
    user?: { login?: string };
    labels?: WebhookLabel[];
    pull_request?: unknown;
  };
}

interface ReviewCommentEvent {
  action?: string;
  installation?: { id?: number };
  repository?: { full_name?: string };
  pull_request?: { number?: number };
  comment?: {
    id?: number;
    in_reply_to_id?: number;
    body?: string;
    user?: { login?: string };
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
  authors: string | readonly string[],
): ReviewJob | null {
  if (eventName === "issue_comment")
    return reviewJobFromComment(payload as IssueCommentEvent, authors);
  if (eventName === "pull_request_review_comment")
    return ignoreJobFromReviewComment(payload as ReviewCommentEvent, authors);
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
  if (pullRequest.draft || !isReviewedAuthor(pullRequest.user?.login, authors)) return null;
  if (hasSkipReviewLabel(pullRequest.labels)) return null;
  return jobFromPullRequest(fullName, number, installationId, pullRequest, false);
}

function reviewJobFromComment(
  payload: IssueCommentEvent,
  authors: string | readonly string[],
): ReviewJob | null {
  if (payload.action !== "created") return null;
  if (!payload.issue?.pull_request) return null;
  if (isDescribeCommand(payload.comment?.body)) return describeJobFromComment(payload, authors);
  if (!isReviewCommand(payload.comment?.body)) return null;
  if (!isReviewedAuthor(payload.comment?.user?.login, authors)) return null;
  if (hasSkipReviewLabel(payload.issue.labels)) return null;
  const fullName = payload.repository?.full_name;
  const installationId = payload.installation?.id;
  const number = payload.issue?.number;
  if (!fullName || !installationId || number === undefined || !Number.isSafeInteger(number))
    return null;
  if (!isReviewedAuthor(payload.issue.user?.login, authors)) return null;
  return {
    key: `${fullName}#${number}`,
    fullName,
    number,
    installationId,
    force: true,
    triggerCommentId: payload.comment?.id,
  };
}

function describeJobFromComment(
  payload: IssueCommentEvent,
  authors: string | readonly string[],
): ReviewJob | null {
  if (!isReviewedAuthor(payload.comment?.user?.login, authors)) return null;
  if (hasSkipReviewLabel(payload.issue?.labels)) return null;
  const fullName = payload.repository?.full_name;
  const installationId = payload.installation?.id;
  const number = payload.issue?.number;
  if (!fullName || !installationId || number === undefined || !Number.isSafeInteger(number))
    return null;
  return {
    key: `${fullName}#${number}`,
    fullName,
    number,
    installationId,
    force: false,
    kind: "describe",
    triggerCommentId: payload.comment?.id,
  };
}

// `/ignore` is only meaningful as a reply under a hedgehog review comment, so a
// top-level comment with no reply target is not an ignore job.
function ignoreJobFromReviewComment(
  payload: ReviewCommentEvent,
  authors: string | readonly string[],
): ReviewJob | null {
  if (payload.action !== "created") return null;
  if (!isIgnoreCommand(payload.comment?.body)) return null;
  if (!isReviewedAuthor(payload.comment?.user?.login, authors)) return null;
  const fullName = payload.repository?.full_name;
  const installationId = payload.installation?.id;
  const number = payload.pull_request?.number;
  const commentId = payload.comment?.id;
  const replyToCommentId = payload.comment?.in_reply_to_id;
  if (
    !fullName ||
    !installationId ||
    number === undefined ||
    !Number.isSafeInteger(number) ||
    commentId === undefined ||
    replyToCommentId === undefined
  )
    return null;
  return {
    key: `${fullName}#${number}`,
    fullName,
    number,
    installationId,
    force: false,
    kind: "ignore",
    replyToCommentId,
    triggerCommentId: commentId,
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
