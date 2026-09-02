import { type DiffLocations, normalizePath, normalizeSide, resolveCommentAnchor } from "./diff.ts";
import { normalizeSeverity, severityRank, tallyLine } from "./signals.ts";
import type { Finding, InlineComment, ParsedReview, Severity, StillApplies } from "./types.ts";

const maxComments = 100;
const maxCommentChars = 16_000;
const maxReviewChars = 65_000;

export function parseReviewOutput(text: unknown): ParsedReview {
  const empty: ParsedReview = {
    summary: "No actionable issues found.",
    findings: [],
    addressedCommentIds: [],
    stillApplies: [],
  };
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return empty;

  const candidates: string[] = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) {
        return {
          summary: "",
          findings: parsed
            .map(normalizeFinding)
            .filter((finding): finding is Finding => finding !== null),
          addressedCommentIds: [],
          stillApplies: [],
        };
      }
      if (parsed && typeof parsed === "object") {
        const source = parsed as Record<string, unknown>;
        const findings = Array.isArray(source.findings) ? source.findings : [];
        return {
          summary: String(source.summary ?? source.body ?? "").trim(),
          findings: findings
            .map(normalizeFinding)
            .filter((finding): finding is Finding => finding !== null),
          addressedCommentIds: normalizeIds(
            source.addressed_comment_ids ?? source.addressedCommentIds,
          ),
          stillApplies: normalizeStillApplies(source.still_applies ?? source.stillApplies),
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { summary: trimmed, findings: [], addressedCommentIds: [], stillApplies: [] };
}

export interface ReviewCommentsResult {
  comments: InlineComment[];
  unmapped: Finding[];
  overflow: Finding[];
}

export function toReviewComments(
  findings: readonly Finding[],
  locations: DiffLocations,
  { includeModel = false }: { includeModel?: boolean } = {},
): ReviewCommentsResult {
  const mapped: Array<{ finding: Finding; comment: InlineComment; rank: number }> = [];
  const unmapped: Finding[] = [];

  for (const finding of findings) {
    const anchor = resolveCommentAnchor(locations, finding);
    if (!anchor) {
      unmapped.push(finding);
      continue;
    }
    const comment: InlineComment = {
      path: anchor.path,
      line: anchor.line,
      side: anchor.side,
      body: formatInlineComment(finding, includeModel),
    };
    mapped.push({
      finding,
      comment,
      rank: severityRank[finding.severity] ?? 4,
    });
  }

  mapped.sort((left, right) => left.rank - right.rank);
  return {
    comments: mapped.slice(0, maxComments).map((item) => item.comment),
    unmapped,
    overflow: mapped.slice(maxComments).map((item) => item.finding),
  };
}

export interface SummaryFinding {
  severity: Severity;
  path: string;
  line?: number;
  body: string;
}

export function buildReviewBody({
  marker,
  summary,
  clean = false,
  severities = [],
  unmapped = [],
  overflow = [],
  headSha,
  modelLabels,
  diffTruncated = false,
}: {
  marker: string;
  summary?: string;
  clean?: boolean;
  severities?: readonly unknown[];
  unmapped?: readonly SummaryFinding[];
  overflow?: readonly SummaryFinding[];
  headSha?: string;
  modelLabels?: string;
  diffTruncated?: boolean;
  /** Accepted for call-site convenience; the count is not rendered. */
  commentCount?: number;
}): string {
  const piVersion = process.env.PI_VERSION || "0.84.4";
  const footer = `\n\n---\n<sub>Reviewed ${shortSha(headSha)} with Pi ${piVersion} using ${modelLabels}.</sub>`;
  const hasFindings = unmapped.length > 0 || overflow.length > 0 || severities.length > 0;
  const modelSummary = String(summary ?? "").trim();
  let overview: string;
  if (clean) {
    overview =
      modelSummary && modelSummary !== "No new findings."
        ? `No new findings.\n\n${modelSummary}`
        : "No new findings.";
  } else {
    overview = modelSummary || (hasFindings ? "See inline comments." : "No new findings.");
  }
  const parts = ["## Pi code review", "", overview];
  const tally = clean ? "" : tallyLine(severities);
  if (tally) parts.push("", tally);
  if (diffTruncated)
    parts.push(
      "",
      "_The diff exceeded the configured size limit and was truncated; parts of this change were not reviewed._",
    );
  appendFindingList(parts, overflow, "### Additional findings (GitHub limit 100)");
  appendFindingList(parts, unmapped, "### Could not attach to the diff");

  const review = parts.join("\n");
  const maxLength = maxReviewChars - marker.length - footer.length;
  const safeReview =
    review.length > maxLength
      ? `${review.slice(0, maxLength)}\n\n_Review output was truncated._`
      : review;
  return `${marker}\n${safeReview}${footer}`;
}

export function formatInlineComment(finding: Finding, includeModel = false): string {
  const severity: Severity = finding.severity || "Low";
  let body = String(finding.body ?? "").trim();
  const prefix = `**${severity}:**`;
  if (!body.toLowerCase().startsWith(`**${severity.toLowerCase()}:**`)) {
    body = body ? `${prefix} ${body}` : prefix;
  }
  if (includeModel && finding.modelLabel) {
    body = `_${finding.modelLabel}_\n\n${body}`;
  }
  if (body.length > maxCommentChars) {
    body = `${body.slice(0, maxCommentChars)}\n\n_Comment truncated._`;
  }
  return body;
}

function normalizeIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.map((value) => Number(value)).filter((id) => Number.isSafeInteger(id) && id > 0),
    ),
  ];
}

function normalizeStillApplies(raw: unknown): StillApplies[] {
  if (!Array.isArray(raw)) return [];
  const items: StillApplies[] = [];
  for (const entry of raw) {
    const value: unknown =
      typeof entry === "number" || typeof entry === "string" ? { id: entry } : entry;
    if (!value || typeof value !== "object") continue;
    const source = value as Record<string, unknown>;
    const id = Number(source.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const path = normalizePath(source.path ?? "");
    const line = Number(source.line);
    if (path && Number.isSafeInteger(line) && line > 0) {
      items.push({
        id,
        path,
        line,
        side: normalizeSide(source.side) || "RIGHT",
        severity: source.severity ? normalizeSeverity(source.severity) : undefined,
        body: String(source.body ?? "").trim(),
      });
    } else {
      items.push({ id });
    }
  }
  return items;
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const source = raw as Record<string, unknown>;
  const path = normalizePath(source.path ?? source.file ?? source.filename ?? "");
  const body = String(source.body ?? source.comment ?? source.message ?? source.text ?? "").trim();
  const line = Number(source.line ?? source.line_number ?? source.lineNumber);
  if (!path || !body || !Number.isSafeInteger(line) || line <= 0) return null;
  return {
    severity: normalizeSeverity(source.severity),
    path,
    line,
    side: normalizeSide(source.side) || "RIGHT",
    start_line: source.start_line ?? source.startLine,
    body,
    modelLabel: source.modelLabel as string | undefined,
  };
}

function appendFindingList(
  parts: string[],
  findings: readonly SummaryFinding[],
  heading: string,
): void {
  if (!findings.length) return;
  parts.push("", heading, "");
  for (const finding of findings) {
    const place = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    parts.push(`- **${finding.severity || "Low"}** \`${place}\` — ${finding.body}`);
  }
}

function shortSha(sha: string | undefined): string {
  return String(sha ?? "").slice(0, 7);
}
