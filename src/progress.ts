import { reviewMarker } from "./config.ts";
import {
  CHECK_NAME,
  DEFAULT_BOT_LOGIN,
  hasSkipReviewLabel,
  isHedgehogLogin,
  reviewHasCurrentMarker,
} from "./signals.ts";
import type {
  CheckOutcome,
  FinishProgressClient,
  IssueReaction,
  Logger,
  ProgressClient,
  PullRequestRef,
  StartProgressClient,
} from "./types.ts";

export interface ProgressSignals {
  eyesReactionId?: number;
  checkRunId?: number;
}

export async function startProgress(
  client: StartProgressClient,
  {
    fullName,
    number,
    headSha,
    botLogin = DEFAULT_BOT_LOGIN,
    logger = console,
  }: {
    fullName: string;
    number: number;
    headSha?: string;
    botLogin?: string;
    logger?: Logger;
  },
): Promise<ProgressSignals> {
  const eyesReactionId = await ensureEyes(client, fullName, number, logger, botLogin);
  let checkRunId: number | undefined;
  try {
    const check = await client.createCheckRun(fullName, {
      headSha,
      name: CHECK_NAME,
      status: "in_progress",
      title: "👀 Reviewing…",
      summary: "Hedgehog is reviewing this pull request.",
    });
    checkRunId = check?.id;
  } catch (error) {
    logger.error?.(`Could not create Pi review check: ${error.message}`);
  }
  return { eyesReactionId, checkRunId };
}

export async function finishProgress(
  client: FinishProgressClient,
  {
    fullName,
    number,
    checkRunId,
    eyesReactionId,
    outcome,
    logger = console,
  }: {
    fullName: string;
    number: number;
    checkRunId?: number;
    eyesReactionId?: number;
    outcome?: CheckOutcome;
    logger?: Logger;
  },
): Promise<void> {
  if (eyesReactionId && typeof client.deleteIssueReaction === "function") {
    try {
      await client.deleteIssueReaction(fullName, number, eyesReactionId);
    } catch (error) {
      logger.error?.(`Could not remove 👀 reaction: ${error.message}`);
    }
  }
  if (checkRunId && outcome && typeof client.updateCheckRun === "function") {
    try {
      await client.updateCheckRun(fullName, checkRunId, {
        status: "completed",
        conclusion: outcome.conclusion,
        title: outcome.title,
        summary: outcome.summary,
      });
    } catch (error) {
      logger.error?.(`Could not complete Pi review check: ${error.message}`);
    }
  }
}

async function ensureEyes(
  client: StartProgressClient,
  fullName: string,
  number: number,
  logger: Logger,
  botLogin: string,
): Promise<number | undefined> {
  if (typeof client.createIssueReaction !== "function") return undefined;
  try {
    if (typeof client.listIssueReactions === "function") {
      const reactions: IssueReaction[] = await client.listIssueReactions(fullName, number);
      const existing = reactions.find(
        (reaction) =>
          reaction.content === "eyes" && isHedgehogLogin(reaction.user?.login, botLogin),
      );
      if (existing) return existing.id;
    }
    const created = await client.createIssueReaction(fullName, number, "eyes");
    return created?.id;
  } catch (error) {
    logger.error?.(`Could not add 👀 reaction: ${error.message}`);
    return undefined;
  }
}

export interface PreparedJob {
  headSha?: string;
  eyesReactionId?: number;
  checkRunId?: number;
}

export async function prepareAcceptedJob<T extends PullRequestRef>(
  client: ProgressClient,
  job: T,
  {
    author,
    fingerprint,
    force = false,
    botLogin = DEFAULT_BOT_LOGIN,
  }: { author: string; fingerprint?: string; force?: boolean; botLogin?: string },
  logger: Logger = console,
): Promise<(T & PreparedJob) | null> {
  const pullRequest = await client.getPullRequest(job.fullName, job.number);
  if (pullRequest.state !== "open" || pullRequest.draft) return null;
  if (pullRequest.user?.login?.toLowerCase() !== author) return null;
  const headSha = pullRequest.head?.sha;
  // Labels and existing reviews are independent reads; fetch them in one round
  // trip before deciding whether to start progress.
  const [labels, reviews] = await Promise.all([
    typeof client.listIssueLabels === "function"
      ? client.listIssueLabels(job.fullName, job.number)
      : undefined,
    !force && fingerprint && headSha && typeof client.listPullRequestReviews === "function"
      ? client.listPullRequestReviews(job.fullName, job.number)
      : undefined,
  ]);
  if (labels && hasSkipReviewLabel(labels)) return null;
  if (
    reviews &&
    headSha &&
    fingerprint &&
    reviewHasCurrentMarker(reviews, reviewMarker(headSha, fingerprint))
  )
    return null;
  const progress = await startProgress(client, {
    fullName: job.fullName,
    number: job.number,
    headSha,
    botLogin,
    logger,
  });
  return { ...job, headSha, ...progress };
}
