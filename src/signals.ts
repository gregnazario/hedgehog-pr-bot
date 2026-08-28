import type {
  CheckOutcome,
  Finding,
  HedgehogThread,
  PullRequestReview,
  ReviewEvent,
  Severity,
  Side,
  StillApplies,
} from "./types.ts";

export const SKIP_REVIEW_LABEL = "skip-review";
export const CHECK_NAME = "Pi review";
export const STILL_APPLIES_REPLY = "Still applies.";

export const severityRank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };

type LabelLike = string | { name?: unknown };

export function hasSkipReviewLabel(labels?: readonly LabelLike[] | null): boolean {
  return (labels ?? []).some((label) => {
    const name = typeof label === "string" ? label : label?.name;
    return String(name ?? "").toLowerCase() === SKIP_REVIEW_LABEL;
  });
}

export function isReviewCommand(body: unknown): boolean {
  const token = String(body ?? "")
    .trim()
    .split(/\s+/)[0];
  return token === "/review";
}

export const DEFAULT_BOT_LOGIN = "hedgehog-pr-bot";

/** GitHub shows bot accounts with a "[bot]" suffix; accept it on either side,
 * case-insensitively, so a value copied straight from the UI just works. */
export function normalizeBotLogin(login: unknown): string {
  return String(login ?? "")
    .replace(/\[bot\]$/i, "")
    .toLowerCase();
}

export function isHedgehogLogin(login: unknown, botLogin = DEFAULT_BOT_LOGIN): boolean {
  return normalizeBotLogin(login) === normalizeBotLogin(botLogin);
}

export function reviewHasCurrentMarker(
  reviews?: readonly PullRequestReview[] | null,
  marker = "",
): boolean {
  if (!marker) return false;
  return (reviews ?? []).some(
    (review) =>
      review.body?.startsWith(marker) &&
      (review.user?.type === "Bot" || isHedgehogLogin(review.user?.login)),
  );
}

export function parseSeverityPrefix(body: unknown): Severity {
  const match = String(body ?? "").match(/\*\*(Critical|High|Medium|Low):\*\*/i);
  if (!match) return "Low";
  return normalizeSeverity(match[1]);
}

export interface ThreadDecisionInput {
  findings?: Finding[];
  addressedCommentIds?: number[];
  stillApplies?: StillApplies[];
  threads?: HedgehogThread[];
}

export interface ThreadDecisions {
  newFindings: Finding[];
  movedFindings: Finding[];
  stillReplies: HedgehogThread[];
  addressed: HedgehogThread[];
}

export function applyThreadDecisions({
  findings = [],
  addressedCommentIds = [],
  stillApplies = [],
  threads = [],
}: ThreadDecisionInput): ThreadDecisions {
  const byId = new Map(threads.map((thread) => [thread.commentId, thread]));
  const stillIds = new Set(stillApplies.map((item) => item?.id).filter((id) => byId.has(id)));

  const addressed: HedgehogThread[] = [];
  for (const id of addressedCommentIds) {
    if (stillIds.has(id)) continue;
    const thread = byId.get(id);
    if (thread) addressed.push(thread);
  }

  const stillReplies: HedgehogThread[] = [];
  const movedFindings: Finding[] = [];
  for (const item of stillApplies) {
    const thread = byId.get(item?.id);
    if (!thread) continue;
    if (item.path && Number.isSafeInteger(Number(item.line)) && Number(item.line) > 0) {
      movedFindings.push({
        severity: item.severity ?? thread.severity,
        path: item.path,
        line: Number(item.line),
        side: item.side || thread.side || "RIGHT",
        body: String(item.body ?? "").trim() || thread.body,
      });
    } else {
      stillReplies.push(thread);
    }
  }

  const occupied = new Set<string>();
  for (const thread of stillReplies)
    occupied.add(locationKey(thread.path, thread.side, thread.line));
  for (const finding of movedFindings)
    occupied.add(locationKey(finding.path, finding.side, finding.line));

  const newFindings = findings.filter(
    (finding) => !occupied.has(locationKey(finding.path, finding.side, finding.line)),
  );
  return { newFindings, movedFindings, stillReplies, addressed };
}

interface SeverityCarrier {
  severity?: unknown;
}

export function collectSeverities({
  newFindings = [],
  movedFindings = [],
  stillReplies = [],
}: {
  newFindings?: readonly SeverityCarrier[];
  movedFindings?: readonly SeverityCarrier[];
  stillReplies?: readonly SeverityCarrier[];
  /** Accepted for call-site convenience; unmapped findings are not tallied. */
  unmapped?: readonly unknown[];
  /** Accepted for call-site convenience; overflow findings are not tallied. */
  overflow?: readonly unknown[];
}): Severity[] {
  return [...newFindings, ...movedFindings, ...stillReplies].map((item) =>
    normalizeSeverity(item.severity),
  );
}

export function reviewEventFromSeverities(severities: readonly unknown[]): ReviewEvent {
  if (!severities.length) return "APPROVE";
  if (severities.some((severity) => severity === "Critical" || severity === "High"))
    return "REQUEST_CHANGES";
  return "COMMENT";
}

export function tallyLine(severities: readonly unknown[]): string {
  const counts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const severity of severities) {
    const key = normalizeSeverity(severity);
    counts[key] += 1;
  }
  const parts: string[] = [];
  for (const name of ["Critical", "High", "Medium", "Low"] as const) {
    if (!counts[name]) continue;
    const icon = severityRank[name] <= 1 ? "⚠️" : "ℹ️";
    parts.push(`${icon} ${counts[name]} ${name}`);
  }
  return parts.join(" · ");
}

export function checkOutcome({
  failed = false,
  errorMessage = "",
  severities = [],
}: {
  failed?: boolean;
  errorMessage?: string;
  severities?: readonly unknown[];
} = {}): CheckOutcome {
  if (failed) {
    const detail = sanitizeCheckText(errorMessage);
    return {
      conclusion: "failure",
      title: "❌ Review failed",
      summary: detail ? `\`\`\`\n${detail}\n\`\`\`` : "Review failed.",
    };
  }
  const high = severities.filter(
    (severity) => severity === "Critical" || severity === "High",
  ).length;
  const rest = severities.length - high;
  if (high) {
    return {
      conclusion: "action_required",
      title: `⚠️ ${high} high/critical`,
      summary: tallyLine(severities) || "Critical or High findings remain.",
    };
  }
  if (rest) {
    return {
      conclusion: "success",
      title: `ℹ️ ${rest} comments`,
      summary: tallyLine(severities),
    };
  }
  return {
    conclusion: "success",
    title: "✅ No new findings",
    summary: "No new findings.",
  };
}

export function sanitizeCheckText(text: unknown, limit = 500): string {
  const cleaned = String(text ?? "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI color sequences.
    .replace(/\u001b\[[0-9;]*m/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips other control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("```", "")
    .trim();
  return cleaned.slice(0, limit);
}

export function normalizeSeverity(value: unknown): Severity {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (text === "critical") return "Critical";
  if (text === "high") return "High";
  if (text === "medium") return "Medium";
  if (text === "low") return "Low";
  return "Low";
}

function locationKey(path: string, side: Side | undefined, line: number): string {
  return `${path}\0${side || "RIGHT"}\0${line}`;
}
