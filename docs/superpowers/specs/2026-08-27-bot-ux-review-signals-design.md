# Hedgehog PR bot UX: progress signals, review events, and thread follow-up

Date: 2026-08-27
Status: approved design, not implemented
Approach: single Pi pass (diff + current unresolved hedgehog threads in one JSON reply)

## Goal

Make hedgehog’s review cycle visible and actionable on the PR without extra merge-gating from the check:

- Show 👀 and a pending `Pi review` check when the worker starts a review (before Pi).
- Finish with a check title that is ❌ (runner failed), ⚠️ (Critical/High), ℹ️ (Medium/Low only), or ✅ (clean).
- APPROVE only when the pass is clean; REQUEST_CHANGES while Critical/High remain; COMMENT for Medium/Low only and clear blocking when Critical/High are gone.
- Ask Pi which previous hedgehog threads are fixed vs still valid; resolve or reply in one pass.
- Let `gregnazario` (`PR_AUTHOR`) force a re-run with `/review` or silence a PR with the `skip-review` label.

## Non-goals

- Deleting leftover hedgehog **issue comments** (the old Conversation-tab blobs). Leave them.
- Reviewing draft PRs, or posting 👀/checks on drafts.
- Custom GitHub reaction emojis (❌ ⚠️ ℹ️). GitHub only supports 👍👎😄😕❤️🎉🚀👀. Completion signal is the check title; 👀 is in-progress only.
- A separate GitHub App “Reactions” permission. That permission is not in the App settings UI. PR 👀 uses the issue-reaction API and is covered by **Pull requests: write**.
- Two Pi passes, or shipping checks/reactions without thread follow-up.
- Auto-review when `skip-review` is removed.
- Reopening already-resolved threads.
- Required-check merge gating on findings (findings must not use check conclusion `failure`).

## Event flow

Same process as today: HTTPS webhook, serial in-memory queue (newest head wins per `fullName#number`), hourly recovery scan. Other authors still exit before any GitHub write.

The HTTP webhook only verifies the signature, parses the event, and enqueues. It returns 202 without calling GitHub, so delivery stays under GitHub’s ~10s timeout. Progress starts when the **queue worker** (or hourly scan) picks up a job it will actually run (open, ready, author matches `PR_AUTHOR`, no `skip-review`, and not already reviewed for this head+config unless `force`):

1. **Start** (worker/scan, before Pi): add 👀 on the PR; create a check run on the head SHA, name `Pi review`, status `in_progress`, title `👀 Reviewing…`. Put `checkRunId` and the 👀 reaction id on the running job.
2. **Work:** fetch diff and unresolved hedgehog review threads; one Pi pass; post the GitHub review; reply/resolve threads; dismiss blocking REQUEST_CHANGES if needed.
3. **Finish:** delete the 👀 reaction; patch the check to ❌ / ⚠️ / ℹ️ / ✅.

If this head+config already has a hedgehog review marker and the job is not `force`, skip 👀 and the check entirely (do not overwrite a real ✅/⚠️ with “Already reviewed”).

If several events pile up for one PR, keep only the newest head. A GitHub check run is bound to the SHA it was created with and cannot be retargeted. Progress is created at run time, so a still-queued job usually has no check to cancel. If a queued job that already opened a check is replaced before Pi starts, mark the old check `cancelled`, create a new `in_progress` check on the new SHA, and keep the existing 👀 (do not add a second). If hedgehog already has 👀 on the PR, reuse that reaction id.

`/review` enqueues with `force: true` and bypasses the “already reviewed this head + config” skip. `skip-review` means do not enqueue, do not 👀, do not open a check. If a run is already in flight when the label is added, that run finishes; the next event does not start another.

Drafts: no 👀, no check, no review until `ready_for_review`.

## Model contract

Pi still returns one JSON object. The prompt includes current **unresolved hedgehog threads** (GitHub comment id, path, line, side, severity if present in the comment, body snippet). Cap the list at 100 threads. Unknown or non-hedgehog IDs in the model output are ignored.

```json
{
  "summary": "short overview, no title heading",
  "findings": [
    {
      "severity": "Critical|High|Medium|Low",
      "path": "…",
      "line": 12,
      "side": "RIGHT",
      "body": "…"
    }
  ],
  "addressed_comment_ids": [101],
  "still_applies": [
    { "id": 202 },
    {
      "id": 303,
      "path": "src/a.mjs",
      "line": 40,
      "side": "RIGHT",
      "severity": "High",
      "body": "…"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `findings` | New issues only. Do not restate an open thread here. |
| `addressed_comment_ids` | Resolve those threads. Do not reopen already-resolved threads. |
| `still_applies` with only `id` | Reply `Still applies.` on that thread unless hedgehog already posted that reply. No new inline comment. |
| `still_applies` with new path/line | Line moved: post a new inline comment there. Do not also reply on the old thread. Leave the old thread open (GitHub marks it outdated). |

Review event and check severity use **new findings + still-applies** (including moved). A leftover High still means REQUEST_CHANGES even if no new thread was opened.

Severity for an id-only `still_applies` entry comes from the thread snapshot we sent to Pi (the `**High:**` prefix on the hedgehog comment), not from the model. If the same issue appears in both `findings` and `still_applies`, keep `still_applies` and drop the duplicate finding.

Clean pass: empty `findings` and empty `still_applies` (every previous thread addressed, or there were none).

## Review events, dismiss, resolve

Each successful pass posts **one new review**. Older hedgehog reviews stay in the timeline.

| This pass | Event | Blocking |
| --- | --- | --- |
| No findings and no still-applies | **APPROVE**. Body includes “No new findings.” | Unblocked. APPROVE from hedgehog supersedes an earlier hedgehog REQUEST_CHANGES. |
| Any Critical or High (new or still-applies) | **REQUEST_CHANGES** | Blocked |
| Only Medium/Low | **COMMENT** | Must not stay blocked: **dismiss** every outstanding **hedgehog** review with state `CHANGES_REQUESTED` (leave other bots alone; they remain visible as dismissed). Do not APPROVE just to unblock. |

Review body, in order:

1. HTML marker (`<!-- greg-pr-bot-review head:… config:… -->`)
2. `## Pi code review`
3. Short model summary (or “No new findings.” when clean)
4. One tally line, e.g. `⚠️ 1 High · ℹ️ 2 Low` (omit counts at zero; omit the line when clean)
5. Unmapped / overflow lists if needed (existing headings)
6. Footer: `Reviewed <sha> with Pi <version> using <models>.`

Do not include “N inline comments were left on the diff.”

After the review is created:

1. Reply `Still applies.` on id-only still-applies threads (`POST /repos/{owner}/{repo}/pulls/{pull}/comments/{comment_id}/replies`).
2. Resolve addressed threads via GraphQL `resolveReviewThread`, mapping comment id → thread id from the list we sent to Pi.
3. Do not delete leftover issue comments.

Thread list for the prompt uses GraphQL (unresolved threads whose first comment is from the hedgehog bot).

## Checks and reactions

One check run per job the worker actually starts, name **`Pi review`**. Create it when the worker starts, not in the webhook handler; patch the same `checkRunId` at finish. `/review` on an already-finished SHA creates a new check run with the same name (GitHub shows the latest).

| When | 👀 | Check |
| --- | --- | --- |
| Worker starts a runnable job | `POST /repos/{owner}/{repo}/issues/{number}/reactions` `{ "content": "eyes" }` | `status: in_progress`, title `👀 Reviewing…` |
| Pi or GitHub flow throws | Delete that 👀 | `conclusion: failure`, title `❌ Review failed`, summary = sanitized error in a fenced block (strip ANSI/control/backticks, truncate) |
| Any Critical or High | Delete 👀 | `conclusion: action_required` (not `failure`), title `⚠️ {n} high/critical` |
| Only Medium/Low | Delete 👀 | `conclusion: success`, title `ℹ️ {n} comments` |
| Clean | Delete 👀 | `conclusion: success`, title `✅ No new findings` |

`{n}` is the count of Critical+High or of Medium+Low findings that actually apply this pass (new + still-applies), not the model’s unmapped wish list.

Do not add 👀 or a check for drafts, other authors, or `skip-review`.

Check/👀 API failures are logged and must not fail the review.

## Commands

Only `PR_AUTHOR` (`gregnazario` by default). Everyone else is ignored (202, `accepted: false`).

**`/review`**

- Webhook: `issue_comment` `created` on a pull request.
- First whitespace-separated token of the comment body is exactly `/review`. Extra text after it is ignored. `/review-foo` does not match.
- Same enqueue as `synchronize`, with `force: true`.
- `issue_comment` payloads do not include `issue.draft` or `pull_request.head`. Parse `/review`, author, `issue.labels`, and `issue.pull_request` existence only; the worker fetches the PR and no-ops on drafts, other authors, or a later `skip-review`.

**`skip-review` label**

- If present: do not 👀, do not open a check, do not enqueue, ignore `/review`.
- Honor on `pull_request` `labeled` / `unlabeled`, on other PR actions, and in the hourly scan.
- In-flight run finishes if the label appears mid-review; the next event does not start another.
- Removing the label does not enqueue; the next `synchronize`, `ready_for_review`, open/reopen, or `/review` does.

## Error handling

- Webhook signature, JSON, and body limits: unchanged (401 / 400 / 413).
- Pi crash, timeout, or GitHub 5xx while reviewing: no new review, no resolve/reply, no dismiss, check → `❌ Review failed`, drop 👀. Do not write the marker. Hourly scan can retry.
- Inline comment 422: existing fallback (summary review, attach one-by-one, recount what landed). Check title and tally use **posted** findings plus still-applies replies that succeeded.
- Resolve/reply failures: log and continue; review and check still complete. Never resolve a thread whose comment id was not in the hedgehog list sent to Pi.
- Dismiss failures: log; check still completes. Merge may stay blocked until a later APPROVE or a successful dismiss.
- TOCTOU: re-list hedgehog reviews and skip create if the marker for this head+config already exists, unless `force` (`/review`).

## Testing

Extend the Node test suite. No live GitHub or Pi.

- Webhook: `/review` from the author enqueues with `force` without reading draft/head from the issue payload; from anyone else or `skip-review` it does not. Worker skips drafts. `labeled` `skip-review` does not enqueue; `unlabeled` does not auto-enqueue.
- Webhook handler returns 202 after enqueue and does not wait on GitHub.
- Review event: clean → APPROVE; Critical/High → REQUEST_CHANGES; Medium/Low → COMMENT and dismiss prior hedgehog `CHANGES_REQUESTED`.
- Threads: addressed ids resolve; id-only still-applies replies `Still applies.` unless already replied; moved still-applies posts a new comment and does not reply; unknown ids ignored.
- Checks/reactions: 👀 + in_progress when the worker starts a runnable job; already-reviewed heads skip progress unless `force`; titles/conclusions for fail / ⚠️ / ℹ️ / ✅; 👀 removed on finish; skip-review and drafts never write them.
- Dismiss: only hedgehog `CHANGES_REQUESTED`, not other bots.
- Tally/check counts: new + moved + still-applies once; do not add unmapped/overflow.
- Format: tally line present; “N inline comments were left” gone; clean body includes “No new findings.”
- Idempotency: marker skip unless `force`; marker re-check before create; failed Pi run does not post a marker.

## Permissions and ops

GitHub App settings (operator must change, then approve the installation prompt):

| Permission | Access |
| --- | --- |
| Contents | read (unchanged) |
| Issues | read/write (unchanged; needed to read `/review` comments) |
| Pull requests | read/write (unchanged; reviews, dismiss, replies, 👀) |
| Checks | **write** (new) |

Subscribe to **Issue comment** in addition to **Pull request**. No new environment variables. Check name is fixed: `Pi review`.

Hourly workflow installation token: add `permission-checks: write`. Do not set a reactions permission (it does not exist on `create-github-app-token`). Keep existing contents/issues/pull-requests grants.

README documents `/review`, `skip-review`, check titles, and the extra Checks permission.

## Success criteria

- A ready PR from the author shows 👀 and `Pi review` in progress until hedgehog finishes or fails.
- Clean pass: APPROVE, “No new findings.”, check `✅ No new findings`.
- Critical/High: REQUEST_CHANGES, check `action_required` with ⚠️, not a red failed check.
- Medium/Low after a High pass: COMMENT, previous hedgehog REQUEST_CHANGES dismissed, check ℹ️, PR not blocked by hedgehog.
- Fixed threads resolve; still-valid threads get `Still applies.` unless the line moved, in which case a new inline comment is posted.
- `/review` from the author re-reviews the current head; `skip-review` silences hedgehog; drafts stay silent.
- Existing issue-comment reviews are left in place.
