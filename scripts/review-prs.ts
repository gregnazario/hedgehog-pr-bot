#!/usr/bin/env node

import { loadReviewConfig, positiveInteger } from "../src/config.ts";
import { errorMessage } from "../src/errors.ts";
import { GitHubClient } from "../src/github.ts";
import { prepareAcceptedJob } from "../src/progress.ts";
import { reviewPullRequest } from "../src/reviewer.ts";
import type { PullRequest } from "../src/types.ts";

if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required");

const config = loadReviewConfig();
const maxReviews = positiveInteger(process.env.MAX_REVIEWS_PER_RUN, 5);
const client = new GitHubClient(process.env.GH_TOKEN, globalThis.fetch, config.botLogin);
const repositories = await client.listInstallationRepositories();
let reviewed = 0;
let failed = 0;

for (const repository of repositories.sort((a, b) => a.full_name.localeCompare(b.full_name))) {
  if (reviewed >= maxReviews) break;
  let pullRequests: PullRequest[];
  try {
    pullRequests = await client.listOpenPullRequests(repository.full_name);
  } catch (error) {
    failed += 1;
    console.error(`Could not list PRs for ${repository.full_name}: ${errorMessage(error)}`);
    continue;
  }

  for (const pullRequest of pullRequests) {
    if (reviewed >= maxReviews) break;
    if (pullRequest.draft || pullRequest.user?.login?.toLowerCase() !== config.author) continue;
    try {
      const prepared = await prepareAcceptedJob(
        client,
        {
          fullName: repository.full_name,
          number: pullRequest.number,
          headSha: pullRequest.head?.sha,
        },
        {
          author: config.author,
          fingerprint: config.fingerprint,
          force: false,
          botLogin: config.botLogin,
        },
      );
      if (!prepared) continue;
      const result = await reviewPullRequest({
        client,
        fullName: repository.full_name,
        number: pullRequest.number,
        config,
        checkRunId: prepared.checkRunId,
        eyesReactionId: prepared.eyesReactionId,
        repoConfig: prepared.repoConfig,
      });
      if (result.status === "reviewed") reviewed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `Review failed for ${repository.full_name}#${pullRequest.number}: ${errorMessage(error)}`,
      );
    }
  }
}

console.log(
  `Finished: ${reviewed} reviewed, ${failed} failed, ${repositories.length} repositories scanned.`,
);
if (failed > 0) process.exitCode = 1;
