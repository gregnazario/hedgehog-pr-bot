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

/** Posts a review result to NOTIFY_WEBHOOK; never throws. */
export async function notifyReview(
  url: string,
  payload: ReviewNotification,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<boolean> {
  if (!url) return false;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
