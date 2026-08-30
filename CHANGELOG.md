# Changelog

All notable changes to hedgehog-pr-bot are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

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
