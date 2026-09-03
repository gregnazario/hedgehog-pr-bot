# Changelog

All notable changes to hedgehog-pr-bot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Per-repository configuration via `.hedgehog.yml`: `skip`, `ignore_paths`,
  `min_severity`, and `verify` shape what gets posted per repo without touching
  server environment variables.
- Live dashboard at `/dashboard` (auto-refreshing HTML) and `/dashboard.json`:
  recent reviews with outcomes, severities, and durations, plus all metrics.
  Optional `DASHBOARD_TOKEN` gates access via query or Bearer header.

## [0.2.0] - 2026-09-02

### Added

- `REVIEW_VERIFY` (default on): a second model pass verifies Critical/High
  findings against the diff before posting — confirming, downgrading, or
  dropping them; verification failures keep the original findings.
- `FILE_CONTEXT_BYTES` (default 64 KiB): complete contents of touched files are
  embedded in the review prompt so findings can reference unchanged code.
- `PI_MODELS_LARGE`: diffs above 500k characters route to a separate model list
  (long-context or cheaper); it participates in the review fingerprint.

- `PI_TIMEOUT_MS` caps each model run (default ten minutes) so a hung Pi process
  cannot block the serial review queue until restart.
- GitHub requests retry `429`/`5xx` responses up to twice, honoring `Retry-After`.
- `NOTIFY_WEBHOOK` receives each review result as JSON.
- A watchdog workflow probes `/healthz` and queue depth every 15 minutes and opens
  (and later closes) an issue on failure; a weekly workflow opens a PR when a newer
  Pi release exists.

### Fixed

- Reviews halve the visible diff and retry (up to three times) when a model
  rejects the prompt for exceeding its context window, instead of failing.
- Reviews no longer fail on pull requests with more than 300 files: when GitHub
  refuses the one-shot diff (406), the diff is rebuilt from the paginated
  per-file patch API.

- Derive thread comment sides from line numbers after GitHub removed the `side`
  field from the GraphQL `PullRequestReviewComment` type; listing unresolved
  threads no longer errors out (thread follow-up works again).

## [0.1.0] - 2026-08-29

First tagged release.

### Added

- Documentation site at <https://gregnazario.github.io/hedgehog-pr-bot/> with a
  configuration reference and a self-hosting guide, deployed by a GitHub Pages
  workflow.
- `BOT_LOGIN` configuration so installations running under a differently named
  GitHub App still recognize their own threads, 👀 reactions, and reviews. Values
  copied from the GitHub UI (with or without the `[bot]` suffix, any casing) work.
- Continuous integration workflow (lint, typecheck, tests on Node 24) with
  SHA-pinned actions.

### Changed

- Migrated from JavaScript to strict TypeScript executed natively by Node.js 24+
  type stripping: no build step and no runtime dependencies.
- Package management moved to bun (`bun.lock`); Biome handles linting and
  formatting.
- Reviews fetch the pull-request diff and existing threads in parallel, and the
  worker fetches labels and existing reviews in parallel, saving GitHub round
  trips.
- Unmapped model findings snap to the nearest diff line using a binary search
  over per-path-and-side buckets instead of scanning every diff line.
- Renamed the package, Compose service, GitHub user agent, and logs from
  greg-pr-bot to hedgehog-pr-bot. The hidden review marker remains
  `<!-- greg-pr-bot-review … -->` so already-posted reviews keep their
  idempotency.

### Removed

- Dead queue replacement check-cancellation path: queued jobs never carried a
  check run id under delete-before-run queue semantics, so the cancel callback
  could never fire.
