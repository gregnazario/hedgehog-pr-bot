import { createHash, timingSafeEqual } from "node:crypto";
import type { Severity } from "./types.ts";

export interface DashboardJob {
  at: string;
  repository: string;
  number: number;
  head: string;
  status: string;
  event?: string;
  severities: Partial<Record<Severity, number>>;
  durationMs: number;
}

const MAX_JOBS = 25;

export class Dashboard {
  private readonly jobs: DashboardJob[] = [];
  private readonly tokenHash: Buffer | null;

  constructor(token: string | undefined) {
    // Store a hash so the secret never sits in memory next to render paths.
    this.tokenHash = token ? createHash("sha256").update(token).digest() : null;
  }

  recordJob(job: DashboardJob): void {
    this.jobs.push(job);
    if (this.jobs.length > MAX_JOBS) this.jobs.splice(0, this.jobs.length - MAX_JOBS);
  }

  /** True when the request may see the dashboard (no token configured, or match). */
  authorized(request: { url?: string; headers: { authorization?: string } }): boolean {
    if (!this.tokenHash) return true;
    const url = new URL(request.url ?? "/", "http://local");
    const query = url.searchParams.get("token") ?? "";
    const header = (request.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    for (const candidate of [query, header]) {
      if (!candidate) continue;
      const candidateHash = createHash("sha256").update(candidate).digest();
      if (timingSafeEqual(candidateHash, this.tokenHash)) return true;
    }
    return false;
  }

  renderJson(queueDepth: number, metricsText: string): string {
    return JSON.stringify(
      {
        time: new Date().toISOString(),
        queueDepth,
        jobs: [...this.jobs].reverse(),
        metrics: metricsText,
      },
      null,
      2,
    );
  }

  renderHtml(queueDepth: number, metricsText: string): string {
    const rows = [...this.jobs]
      .reverse()
      .map(
        (job) => `<tr>
          <td>${escapeHtml(job.at)}</td>
          <td><a href="https://github.com/${escapeHtml(job.repository)}/pull/${job.number}">${escapeHtml(job.repository)}#${job.number}</a></td>
          <td><code>${escapeHtml(job.head.slice(0, 7))}</code></td>
          <td>${escapeHtml(job.status)}${job.event ? ` (${escapeHtml(job.event)})` : ""}</td>
          <td>${escapeHtml(severitySummary(job.severities))}</td>
          <td>${(job.durationMs / 1000).toFixed(1)}s</td>
        </tr>`,
      )
      .join("\n");
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="refresh" content="10" />
<title>🦔 hedgehog-pr-bot</title>
<style>
  body { margin: 0; background: #1a1613; color: #ece5dc; font-family: ui-sans-serif, system-ui, sans-serif; padding: 2rem 1.25rem 4rem; }
  main { max-width: 52rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; margin: 1rem 0 2rem; }
  th, td { text-align: left; padding: 0.45rem 0.6rem; border-bottom: 1px solid #3a322a; }
  th { color: #a1968a; font-weight: 600; }
  a { color: #fbbf24; text-decoration: none; }
  code { background: #2b251f; border-radius: 0.3rem; padding: 0.05rem 0.3rem; }
  pre { background: #2b251f; border: 1px solid #3a322a; border-radius: 0.5rem; padding: 1rem; overflow-x: auto; font-size: 0.8rem; line-height: 1.5; }
  .muted { color: #a1968a; }
</style>
</head>
<body>
<main>
  <h1>🦔 hedgehog-pr-bot</h1>
  <p class="muted">queue depth: ${queueDepth} · refreshed every 10s</p>
  <table>
    <thead><tr><th>time</th><th>pull request</th><th>head</th><th>result</th><th>findings</th><th>took</th></tr></thead>
    <tbody>
${rows || '<tr><td colspan="6" class="muted">no reviews yet</td></tr>'}
    </tbody>
  </table>
  <p class="muted">metrics</p>
  <pre>${escapeHtml(metricsText)}</pre>
</main>
</body>
</html>`;
  }
}

function severitySummary(severities: Partial<Record<Severity, number>>): string {
  const order: Severity[] = ["Critical", "High", "Medium", "Low"];
  return order
    .filter((severity) => severities[severity])
    .map((severity) => `${severities[severity]} ${severity}`)
    .join(", ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
