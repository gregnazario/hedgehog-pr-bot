# hedgehog-pr-bot

An open-source, account-wide pull-request reviewer for `gregnazario`. It uses
[Pi](https://github.com/earendil-works/pi) as the coding harness. The default model is
GLM-5.3 through a Z.AI Coding Plan subscription, and the model list is configurable.

The bot is written in strict TypeScript and runs directly on Node.js 24 or newer, which
strips types natively — there is no build step and no runtime dependency; `typescript`,
`@types/node`, and `@biomejs/biome` are dev-only tools for typechecking, linting, and
formatting.
Documentation for self-hosting and the full configuration reference live at
<https://gregnazario.github.io/hedgehog-pr-bot/>.

The bot is event driven. A single long-running server receives GitHub App webhooks and
queues a review immediately when one of your PRs is opened, reopened, marked ready, or
updated with new commits. The PR shows a 🥚 **queued** check from the moment the webhook
is accepted; the worker adopts it as a 👀 **in-progress** check (with per-model progress
when several models are configured) while Pi runs, then posts findings as GitHub review
comments on the changed lines with a short summary on the review itself. No workflow file
is needed in the repositories being reviewed.

An hourly GitHub Actions scan remains as a recovery path for deliveries missed while the
server is unavailable. The review marker makes both paths idempotent, so they do not post
duplicate reviews for the same PR head and model configuration. Comment `/review` on a PR
to force another pass of the current head — the bot reacts 👀 to the comment immediately.
Reply `/ignore` under any hedgehog comment to mute that finding on future passes. Add the
`skip-review` label to silence hedgehog on that PR.

## What it reviews

- Security vulnerabilities and unsafe trust boundaries
- Correctness bugs and edge cases
- Performance and scalability problems
- Reliability, maintainability, and general code quality

Draft PRs and PRs opened by other authors are skipped (no 👀, no check). Reviews run
sequentially to avoid overloading the Coding Plan. If several events for one PR are
waiting, only the newest is kept; the reviewer fetches the current PR state again before
running Pi.

A clean pass **approves** with “No new findings.” Critical or High findings
**request changes**. Medium or Low only **comment**, and hedgehog dismisses its own
outstanding change requests so they do not keep blocking. The check concludes
`action_required` (⚠️) for Critical/High, `success` (ℹ️ or ✅) otherwise, and `failure`
(❌) only when Pi or GitHub breaks.

## Run the server

Requirements: Docker with Compose, a public HTTPS endpoint, and the existing GitHub App
credentials.

1. Copy `.env.example` to `.env`.
2. Put the App client ID, base64-encoded private key, webhook secret, and Z.AI API key in
   `.env`. Never commit this file.
3. Start the service:

   ```sh
   docker compose up -d --build
   ```

4. Put an HTTPS reverse proxy in front of local port 3000. Its public webhook URL is:

   ```text
   https://ms.sed.fyi/github/webhook
   ```

5. In the GitHub App settings, enable webhooks, enter that URL and the exact same webhook
   secret, then subscribe to **Pull request**, **Issue comment**, and
   **Pull request review comment** events (the last one powers `/ignore`).
6. Check `https://ms.sed.fyi/healthz`; it should return `{"ok":true,...}`.

The Compose service restarts automatically, runs read-only as an unprivileged user, drops
Linux capabilities, and exposes port 3000 on localhost by default for a reverse proxy.
Set `BIND_ADDRESS=0.0.0.0` in `.env` only if the host firewall and TLS proxy require it;
use `BIND_PORT` to change the host-side port.

## GitHub App permissions

Install the App on all repositories to review, or select a smaller set. It needs:

- Contents: read and write (write is needed only because GitHub gates review-thread
  resolution behind it; hedgehog never pushes commits)
- Issues: read and write (needed to read `/review` comments)
- Pull requests: read and write (reviews, dismissals, replies, and the 👀 reaction)
- Checks: write (the `Pi review` check run)

There is no separate Reactions permission in GitHub App settings. Approving the extra
Checks permission on each installation is required after you add it.

To add future repositories, update the App installation. No repository code change is
needed.

The hourly recovery workflow also needs these settings in this repository:

- Repository variable `APP_CLIENT_ID`
- Repository secret `APP_PRIVATE_KEY`
- Repository secret `ZAI_API_KEY`
- Optional repository variable `PI_MODELS`

## Security model

Every webhook body is verified against `X-Hub-Signature-256` using HMAC-SHA256 and a
constant-time comparison before it is parsed or queued. The server exchanges a short-lived,
RS256-signed GitHub App JWT for an installation token and caches that token only in memory.

The controller can read PR diffs and submit pull request reviews, but GitHub tokens, the
App private key, and the webhook secret are removed from Pi's environment. Pi runs with tools,
extensions, skills, context files, sessions, and project trust disabled. PR titles,
descriptions, and diffs are model input only; they cannot execute commands or read server
secrets.

Secrets belong only in the server environment or GitHub encrypted secrets. `.env`, PEM,
and key files are ignored by Git. `.env.example` contains placeholders only.

## Configuration

| Variable | Default | Purpose |
| --- | ---: | --- |
| `APP_CLIENT_ID` | required | GitHub App client ID (an App ID also works) |
| `APP_PRIVATE_KEY_BASE64` | required | Base64-encoded GitHub App private key PEM |
| `GITHUB_WEBHOOK_SECRET` | required | High-entropy webhook signing secret |
| `ZAI_API_KEY` | required for default | Z.AI Coding Plan credential used by Pi |
| `PI_MODELS` | `zai/glm-5.3:high` | Comma-separated `provider/model[:thinking]` reviewers |
| `PI_MODELS_LARGE` | unset | Reviewers used for diffs above 500k characters (long-context or cheaper models); participates in the review fingerprint |
| `REVIEW_VERIFY` | `true` | Second model pass that confirms, downgrades, or drops Critical/High findings before posting; `false` disables |
| `FILE_CONTEXT_BYTES` | `65536` | Bytes of complete touched-file contents embedded in the prompt; `0` disables |
| `PR_AUTHOR` | `gregnazario` | Only review PRs opened by this GitHub user |
| `PR_AUTHORS` | `PR_AUTHOR` | Comma-separated list of reviewed authors (maintainer mode) |
| `REVIEW_MEMORY_PATH` | unset | File persisting `/ignore` fingerprints; unset disables the memory |
| `LOG_FORMAT` | `text` | `json` emits one `{time, level, message}` object per log line |
| `PI_TIMEOUT_MS` | `600000` | Wall-clock cap for one model run; protects the serial queue |
| `NOTIFY_WEBHOOK` | unset | URL posted each review result (Slack/Discord/generic) |
| `DASHBOARD_TOKEN` | unset | When set, `/dashboard` requires this token (`?token=` or Bearer) |
| `REVIEW_HISTORY_PATH` | unset | JSONL file keeping dashboard history across restarts |
| `NOTIFY_WEBHOOK_FORMAT` | `json` | `slack` wraps notifications as `{text}` for Slack incoming webhooks |
| `PI_VERSION` | `0.84.4` | Pi version stamped into review footers |
| `BOT_LOGIN` | `hedgehog-pr-bot` | The App's bot account slug; set it when self-hosting under a different App name |
| `MAX_DIFF_CHARS` | `4000000` | Maximum diff characters sent to each model |
| `HOST` | `0.0.0.0` | Address inside the container |
| `PORT` | `3000` | HTTP port |
| `BIND_ADDRESS` | `127.0.0.1` | Docker Compose host binding |
| `BIND_PORT` | `3000` | Docker Compose host-side port |
| `DOMAIN` | unset | Required only by the optional compose `tls` profile (Caddy) |

For example, multiple models can review each revision independently:

```text
PI_MODELS=zai/glm-5.3:high,zai/glm-4.7:high
```

Changing `PI_MODELS` changes the review fingerprint, so the recovery scan reviews existing
open PRs again even if their head SHA is unchanged. Pi supports other providers; add only
the corresponding API-key environment variable needed by each configured model.

## Operations

```sh
docker compose ps
docker compose logs -f hedgehog-pr-bot
docker compose pull
docker compose up -d --build
```

The queue is intentionally in memory. GitHub retries failed webhook deliveries, and the
hourly workflow reconciles open PRs after an outage (it also sweeps 🥚 queued checks a
restart may have stranded). Large diffs are capped at four million characters; the review
body says when truncation happened. Inline comments are only attached to lines that appear
in the pull request diff; anything the model cannot place is kept in the review summary.
Previous hedgehog threads that are still valid get a “Still applies.” reply instead of a
duplicate comment, unless the line moved. When several models run, findings on the same
line merge into one comment listing every model that agreed.

`GET /healthz` answers liveness; `GET /metrics` serves Prometheus counters (webhook
events, job results, ignore jobs, queue depth); `GET /dashboard` renders a live page
with the last reviews and counters (auto-refreshing, no build step), with the same
data at `/dashboard.json`. Set `DASHBOARD_TOKEN` to require a token.

## Per-repository configuration

Repositories can tune their own reviews with a `.hedgehog.yml` at the reviewed head:

```yaml
# Silence hedgehog on this repository entirely.
skip: false

# Findings under these path prefixes are never posted.
ignore_paths: [dist, vendor, generated]

# Drop findings below this severity (Critical|High|Medium|Low).
min_severity: Medium

# Override the server's REVIEW_VERIFY for this repository.
verify: false

# Maintainer review guidance, included verbatim in the model prompt.
instructions: |
  We use React 19 server components; flag client-only hooks.

# Ask for a file-by-file walkthrough section in each review.
walkthrough: true

# Per-repository model list (changes the review fingerprint).
models: zai/glm-4.7:low

# Review only these categories (default: security, correctness,
# performance, reliability, maintainability).
focus: [security, correctness]
```

Missing files, unknown keys, and invalid values are ignored, so the schema can
grow without breaking old checkouts. The posting filters do not change the
review fingerprint; `models` does, so changing it re-reviews open PRs. `focus`
accepts: security, correctness, performance, reliability, maintainability,
tests, accessibility. Focused repos get a glossed, scoped prompt — issues
outside the focus are still reported when Critical — and `instructions` remains
the escape hatch for anything the taxonomy does not express.

Comment `/describe` on a PR to have hedgehog draft a title and description from
the diff and post them as a comment to copy into the PR. For automatic TLS on a spare domain, run
`docker compose --profile tls up -d` with `DOMAIN` set — a Caddy sidecar handles
certificates. A ready-made image is published to
`ghcr.io/gregnazario/hedgehog-pr-bot:latest` on every push to main. Self-hosters can
pre-fill their GitHub App with `.github/app-manifest.yml` (see the docs site).

## Development

The source is TypeScript (`src/*.ts`, `test/*.test.ts`, `scripts/*.ts`) with no build
step: Node.js 24+ executes `.ts` files by stripping types, so imports use explicit
`.ts` extensions and only erasable syntax is allowed (no enums or namespaces; enforced
by `erasableSyntaxOnly` in `tsconfig.json`).

Use bun as the package manager (the lockfile is `bun.lock`). Note that `bun test`
invokes Bun's own test runner, so use the script form `bun run test` to run the
Node test suite:

```sh
bun install        # dev-only: typescript, @types/node, @biomejs/biome
bun run test       # node --test suite
bun run typecheck  # tsc --noEmit over src, test, and scripts
bun run lint       # biome check: formatting, import order, lint rules
bun run format     # biome format --write
bun run fix        # biome check --write: format + safe lint/import fixes
```

The Compose image installs no project dependencies at all; it copies `src/` and
`scripts/` and runs `node src/server.ts` directly.
