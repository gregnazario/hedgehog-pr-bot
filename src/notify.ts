import type { FetchLike, Severity } from "./types.ts";

export interface ReviewNotification {
  type: "review";
  repository: string;
  pull_request: number;
  head: string;
  status: string;
  event?: string;
  severities: Partial<Record<Severity, number>>;
}

export type NotifyFormat = "json" | "slack";

function slackText(payload: ReviewNotification): string {
  const findings = Object.entries(payload.severities)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");
  const head = payload.head.slice(0, 7);
  const outcome = payload.event ? `${payload.status} (${payload.event})` : payload.status;
  return `🦔 ${payload.repository}#${payload.pull_request} (${head}): ${outcome}${findings ? ` · ${findings}` : ""}`;
}

/** Posts a review result to NOTIFY_WEBHOOK; never throws. */
export async function notifyReview(
  url: string,
  payload: ReviewNotification,
  format: NotifyFormat = "json",
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<boolean> {
  if (!url) return false;
  try {
    const body = format === "slack" ? { text: slackText(payload) } : payload;
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function severityCounts(severities: readonly Severity[]): Partial<Record<Severity, number>> {
  const counts: Partial<Record<Severity, number>> = {};
  for (const severity of severities) counts[severity] = (counts[severity] ?? 0) + 1;
  return counts;
}
