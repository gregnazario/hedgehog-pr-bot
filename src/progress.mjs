import { reviewMarker } from "./config.mjs";
import { CHECK_NAME, hasSkipReviewLabel, isHedgehogLogin, reviewHasCurrentMarker } from "./signals.mjs";

export async function startProgress(client, { fullName, number, headSha, logger = console }) {
  const eyesReactionId = await ensureEyes(client, fullName, number, logger);
  let checkRunId;
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

export async function finishProgress(client, {
  fullName,
  number,
  checkRunId,
  eyesReactionId,
  outcome,
  logger = console,
}) {
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

export async function cancelQueuedProgress(client, { fullName, checkRunId, logger = console }) {
  if (!checkRunId || typeof client.updateCheckRun !== "function") return;
  try {
    await client.updateCheckRun(fullName, checkRunId, {
      status: "completed",
      conclusion: "cancelled",
      title: "Superseded by a newer head",
      summary: "A newer commit replaced this review job.",
    });
  } catch (error) {
    logger.error?.(`Could not cancel Pi review check: ${error.message}`);
  }
}

async function ensureEyes(client, fullName, number, logger) {
  if (typeof client.createIssueReaction !== "function") return undefined;
  try {
    if (typeof client.listIssueReactions === "function") {
      const reactions = await client.listIssueReactions(fullName, number);
      const existing = reactions.find((reaction) => (
        reaction.content === "eyes" && isHedgehogLogin(reaction.user?.login)
      ));
      if (existing) return existing.id;
    }
    const created = await client.createIssueReaction(fullName, number, "eyes");
    return created?.id;
  } catch (error) {
    logger.error?.(`Could not add 👀 reaction: ${error.message}`);
    return undefined;
  }
}

export async function prepareAcceptedJob(client, job, { author, fingerprint, force = false } = {}, logger = console) {
  const pullRequest = await client.getPullRequest(job.fullName, job.number);
  if (pullRequest.state !== "open" || pullRequest.draft) return null;
  if (pullRequest.user?.login?.toLowerCase() !== author) return null;
  if (typeof client.listIssueLabels === "function") {
    const labels = await client.listIssueLabels(job.fullName, job.number);
    if (hasSkipReviewLabel(labels)) return null;
  }
  const headSha = pullRequest.head?.sha;
  if (!force && fingerprint && typeof client.listPullRequestReviews === "function") {
    const reviews = await client.listPullRequestReviews(job.fullName, job.number);
    if (reviewHasCurrentMarker(reviews, reviewMarker(headSha, fingerprint))) return null;
  }
  const progress = await startProgress(client, {
    fullName: job.fullName,
    number: job.number,
    headSha,
    logger,
  });
  return { ...job, headSha, ...progress };
}
