import { reviewMarker } from "./config.ts";
import { errorMessage } from "./errors.ts";
import {
  CHECK_NAME,
  DEFAULT_BOT_LOGIN,
  hasSkipReviewLabel,
  isHedgehogLogin,
  isReviewedAuthor,
  reviewHasCurrentMarker,
  withRerunHint,
} from "./signals.ts";
import type {
  CheckOutcome,
  CheckRunRecord,
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

/** Opens the queued check shown between webhook acceptance and the review slot. */
export async function startQueuedProgress(
  client: StartProgressClient,
  { fullName, headSha, logger = console }: { fullName: string; headSha?: string; logger?: Logger },
): Promise<number | undefined> {
  try {
    const check = await client.createCheckRun(fullName, {
      headSha,
      name: CHECK_NAME,
      status: "queued",
      title: "🥚 Queued",
      summary: "Waiting for a review slot.",
    });
    return check?.id;
  } catch (error) {
    logger.error?.(`Could not open queued Pi review check: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function startProgress(
  client: StartProgressClient,
  {
    fullName,
    number,
    headSha,
    adoptCheckRunId,
    botLogin = DEFAULT_BOT_LOGIN,
    logger = console,
  }: {
    fullName: string;
    number: number;
    headSha?: string;
    adoptCheckRunId?: number;
    botLogin?: string;
    logger?: Logger;
  },
): Promise<ProgressSignals> {
  const eyesReactionId = await ensureEyes(client, fullName, number, logger, botLogin);
  let checkRunId = await adoptQueuedCheck(client, {
    fullName,
    checkRunId: adoptCheckRunId,
    logger,
  });
  if (checkRunId) return { eyesReactionId, checkRunId };
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
    logger.error?.(`Could not create Pi review check: ${errorMessage(error)}`);
  }
  return { eyesReactionId, checkRunId };
}

async function adoptQueuedCheck(
  client: StartProgressClient,
  { fullName, checkRunId, logger }: { fullName: string; checkRunId?: number; logger: Logger },
): Promise<number | undefined> {
  if (!checkRunId || typeof client.updateCheckRun !== "function") return undefined;
  try {
    await client.updateCheckRun(fullName, checkRunId, {
      status: "in_progress",
      title: "👀 Reviewing…",
      summary: "Hedgehog is reviewing this pull request.",
    });
    return checkRunId;
  } catch (error) {
    logger.error?.(`Could not adopt queued Pi review check: ${errorMessage(error)}`);
    return undefined;
  }
}

/** Completes an inherited queued check when the job turns out not to run. */
export async function abandonQueuedProgress(
  client: FinishProgressClient,
  {
    fullName,
    checkRunId,
    title = "Skipped",
    summary,
    logger = console,
  }: { fullName: string; checkRunId?: number; title?: string; summary: string; logger?: Logger },
): Promise<void> {
  if (!checkRunId || typeof client.updateCheckRun !== "function") return;
  try {
    await client.updateCheckRun(fullName, checkRunId, {
      status: "completed",
      conclusion: "skipped",
      title,
      summary,
    });
  } catch (error) {
    logger.error?.(`Could not skip queued Pi review check: ${errorMessage(error)}`);
  }
}

/** Cancels the queued check of a pending job replaced by a newer head. */
export async function cancelQueuedProgress(
  client: FinishProgressClient,
  {
    fullName,
    checkRunId,
    logger = console,
  }: { fullName: string; checkRunId?: number; logger?: Logger },
): Promise<void> {
  if (!checkRunId || typeof client.updateCheckRun !== "function") return;
  try {
    await client.updateCheckRun(fullName, checkRunId, {
      status: "completed",
      conclusion: "cancelled",
      title: "Superseded by a newer head",
      summary: "A newer commit replaced this review job.",
    });
  } catch (error) {
    logger.error?.(`Could not cancel Pi review check: ${errorMessage(error)}`);
  }
}

/** Completes queued checks orphaned by a server restart mid-queue. */
export async function sweepStaleQueuedChecks(
  client: FinishProgressClient & {
    listCheckRuns(fullName: string, ref: string, name?: string): Promise<CheckRunRecord[]>;
  },
  {
    fullName,
    headSha,
    olderThanMs = 2 * 60 * 60_000,
    now = Date.now(),
    logger = console,
  }: { fullName: string; headSha?: string; olderThanMs?: number; now?: number; logger?: Logger },
): Promise<number> {
  if (!headSha) return 0;
  try {
    const checks = await client.listCheckRuns(fullName, headSha, CHECK_NAME);
    let swept = 0;
    for (const check of checks) {
      if (check.status !== "queued") continue;
      const startedAt = Date.parse(check.started_at ?? "");
      if (!Number.isFinite(startedAt) || now - startedAt < olderThanMs) continue;
      await abandonQueuedProgress(client, {
        fullName,
        checkRunId: check.id,
        title: "Stale queued check",
        summary: "The server restarted before this review ran; the next push or /review retries.",
        logger,
      });
      swept += 1;
    }
    return swept;
  } catch (error) {
    logger.error?.(`Could not sweep stale Pi review checks: ${errorMessage(error)}`);
    return 0;
  }
}

export async function reportModelProgress(
  client: FinishProgressClient,
  {
    fullName,
    checkRunId,
    modelsDone,
    modelsTotal,
    findingsSoFar,
    lastLabel,
    logger = console,
  }: {
    fullName: string;
    checkRunId?: number;
    modelsDone: number;
    modelsTotal: number;
    findingsSoFar: number;
    lastLabel: string;
    logger?: Logger;
  },
): Promise<void> {
  if (!checkRunId || typeof client.updateCheckRun !== "function") return;
  try {
    await client.updateCheckRun(fullName, checkRunId, {
      status: "in_progress",
      title: "👀 Reviewing…",
      summary: `${modelsDone}/${modelsTotal} models done · ${findingsSoFar} findings · last: ${lastLabel}`,
    });
  } catch (error) {
    logger.error?.(`Could not update review progress: ${errorMessage(error)}`);
  }
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
      logger.error?.(`Could not remove 👀 reaction: ${errorMessage(error)}`);
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
      logger.error?.(`Could not complete Pi review check: ${errorMessage(error)}`);
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
    logger.error?.(`Could not add 👀 reaction: ${errorMessage(error)}`);
    return undefined;
  }
}

export interface PreparedJob {
  headSha?: string;
  eyesReactionId?: number;
  checkRunId?: number;
}

export async function prepareAcceptedJob<T extends PullRequestRef & { checkRunId?: number }>(
  client: ProgressClient,
  job: T,
  {
    author,
    fingerprint,
    force = false,
    botLogin = DEFAULT_BOT_LOGIN,
  }: {
    author?: string | readonly string[];
    fingerprint?: string;
    force?: boolean;
    botLogin?: string;
  },
  logger: Logger = console,
): Promise<(T & PreparedJob) | null> {
  const pullRequest = await client.getPullRequest(job.fullName, job.number);
  if (pullRequest.state !== "open" || pullRequest.draft) {
    await abandonQueuedProgress(client, {
      fullName: job.fullName,
      checkRunId: job.checkRunId,
      summary: "The pull request is closed or still a draft.",
    });
    return null;
  }
  if (!isReviewedAuthor(pullRequest.user?.login, author ?? [])) {
    await abandonQueuedProgress(client, {
      fullName: job.fullName,
      checkRunId: job.checkRunId,
      summary: "The pull request author is not reviewed.",
    });
    return null;
  }
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
  if (labels && hasSkipReviewLabel(labels)) {
    await abandonQueuedProgress(client, {
      fullName: job.fullName,
      checkRunId: job.checkRunId,
      summary: "The skip-review label is set.",
    });
    return null;
  }
  if (
    reviews &&
    headSha &&
    fingerprint &&
    reviewHasCurrentMarker(reviews, reviewMarker(headSha, fingerprint))
  ) {
    await abandonQueuedProgress(client, {
      fullName: job.fullName,
      checkRunId: job.checkRunId,
      title: "Already reviewed",
      summary: withRerunHint("This head was already reviewed."),
    });
    return null;
  }
  const progress = await startProgress(client, {
    fullName: job.fullName,
    number: job.number,
    headSha,
    adoptCheckRunId: job.checkRunId,
    botLogin,
    logger,
  });
  return { ...job, headSha, ...progress };
}
