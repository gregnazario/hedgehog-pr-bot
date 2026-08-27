# Hedgehog Review Signals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved UX spec: 👀 plus a `Pi review` check, severity-based APPROVE / REQUEST_CHANGES / COMMENT, single-pass thread follow-up, `/review` and `skip-review`.

**Architecture:** Keep the serial webhook queue. On accept, best-effort 👀 + in-progress check, then one Pi pass that also decides thread resolve/reply. New pure helpers live in `src/signals.mjs`; GitHub API additions stay on `GitHubClient`. Findings never conclude the check as `failure`.

**Tech Stack:** Node.js 24, built-in `node:test`, GitHub REST + GraphQL, existing Pi spawn.

## Global Constraints

- Check name is exactly `Pi review`.
- Skip label is exactly `skip-review` (case-insensitive match).
- `/review` matches only when the first whitespace-separated token is exactly `/review`.
- Only `PR_AUTHOR` (default `gregnazario`) may `/review` or be reviewed.
- Drafts: no 👀, no check, no review.
- 👀 uses `POST /repos/{owner}/{repo}/issues/{number}/reactions` `{ "content": "eyes" }` (Pull requests: write). No Reactions App permission.
- Check conclusions: crash → `failure` `❌ Review failed`; Critical/High → `action_required` `⚠️ {n} high/critical`; Medium/Low → `success` `ℹ️ {n} comments`; clean → `success` `✅ No new findings`.
- Clean review event: `APPROVE` with body containing `No new findings.`
- Any Critical/High (new or still-applies): `REQUEST_CHANGES`.
- Only Medium/Low: `COMMENT`, then dismiss outstanding hedgehog `CHANGES_REQUESTED` reviews.
- Still-applies id-only: reply `Still applies.` Moved still-applies: new inline comment, no reply. Addressed: GraphQL `resolveReviewThread`.
- Do not delete leftover issue comments.
- Unknown thread IDs are ignored.
- Check/👀/resolve/reply/dismiss failures log and do not fail the review (except Pi/GitHub failures during the review itself still fail the check).
- No new env vars.

## File structure

- Create: `src/signals.mjs` — labels, tally, check outcome, review event, thread decisions
- Create: `src/progress.mjs` — start/finish/cancel 👀 + check runs
- Create: `test/signals.test.mjs`, `test/progress.test.mjs`
- Modify: `src/review-format.mjs`, `test/review-format.test.mjs`
- Modify: `src/github.mjs`, `test/github.test.mjs`
- Modify: `src/queue.mjs`, `test/queue.test.mjs`
- Modify: `src/webhook.mjs`, `test/webhook.test.mjs`
- Modify: `src/reviewer.mjs`, `test/reviewer.test.mjs`
- Modify: `src/server.mjs`, `test/server.test.mjs`
- Modify: `scripts/review-prs.mjs`
- Modify: `.github/workflows/review.yml`, `README.md`

---

### Task 1: Pure signal helpers

**Files:**
- Create: `src/signals.mjs`
- Test: `test/signals.test.mjs`

**Produces:** `SKIP_REVIEW_LABEL`, `CHECK_NAME`, `STILL_APPLIES_REPLY`, `hasSkipReviewLabel(labels)`, `isReviewCommand(body)`, `isHedgehogLogin(login)`, `parseSeverityPrefix(body)`, `applyThreadDecisions({ findings, addressedCommentIds, stillApplies, threads })`, `reviewEventFromSeverities(severities)`, `tallyLine(severities)`, `checkOutcome({ failed, errorMessage, severities })`

- [ ] **Step 1–4:** TDD the helpers (skip label, `/review` token, hedgehog login, thread decisions, events, tally, check titles).
- [ ] **Step 5:** Commit.

---

### Task 2: Review body + JSON parse

**Files:**
- Modify: `src/review-format.mjs`
- Test: `test/review-format.test.mjs`

**Produces:** `parseReviewOutput` also returns `addressedCommentIds` and `stillApplies`. `buildReviewBody` takes `severities` / `clean`, adds tally, omits “N inline comments were left”, clean text includes `No new findings.`

- [ ] TDD parse + body, commit.

---

### Task 3: GitHub client methods

**Files:**
- Modify: `src/github.mjs`
- Test: `test/github.test.mjs`

**Produces:** `listIssueLabels`, `listIssueReactions`, `createIssueReaction`, `deleteIssueReaction`, `createCheckRun`, `updateCheckRun`, `dismissPullRequestReview`, `createPullRequestReviewCommentReply`, `graphql`, `listUnresolvedHedgehogThreads` (unresolved, first comment hedgehog bot, cap 100).

- [ ] TDD request shapes, commit.

---

### Task 4: Queue replace hook

**Files:**
- Modify: `src/queue.mjs`
- Test: `test/queue.test.mjs`

**Produces:** `onReplace(previous, next)` when a pending job for the same key is overwritten, before drain.

- [ ] TDD, commit.

---

### Task 5: Webhook jobs

**Files:**
- Modify: `src/webhook.mjs`
- Test: `test/webhook.test.mjs`

**Produces:** `force: true` on `/review` from author; null for other commenters, drafts, skip-review, `/review-foo`, `labeled`/`unlabeled`; PR jobs include `force: false` and skip when labels contain `skip-review`.

- [ ] TDD, commit.

---

### Task 6: Progress + reviewer orchestration + server + scan + docs

**Files:**
- Create: `src/progress.mjs`
- Modify: `src/reviewer.mjs`, `src/server.mjs`, `scripts/review-prs.mjs`, `.github/workflows/review.yml`, `README.md`
- Test: `test/progress.test.mjs`, `test/reviewer.test.mjs`, `test/server.test.mjs`

Wire startProgress on accept, cancel superseded queued checks, Pi bundle includes previous threads, review event/dismiss/reply/resolve, finish check, no issue-comment deletion, `force` bypasses marker, TOCTOU re-check, `permission-checks: write`.

- [ ] TDD then implement, run `npm test`, commit.
