import { normalizePath, normalizeSide, resolveCommentAnchor } from "./diff.mjs";
import { tallyLine } from "./signals.mjs";

const severityRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };
const maxComments = 100;
const maxCommentChars = 16_000;
const maxReviewChars = 65_000;

export function parseReviewOutput(text) {
  const empty = { summary: "No actionable issues found.", findings: [], addressedCommentIds: [], stillApplies: [] };
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return empty;

  const candidates = [];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(match[1]);
  }
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (Array.isArray(parsed)) {
        return {
          summary: "",
          findings: parsed.map(normalizeFinding).filter(Boolean),
          addressedCommentIds: [],
          stillApplies: [],
        };
      }
      if (parsed && typeof parsed === "object") {
        const findings = Array.isArray(parsed.findings) ? parsed.findings : [];
        return {
          summary: String(parsed.summary ?? parsed.body ?? "").trim(),
          findings: findings.map(normalizeFinding).filter(Boolean),
          addressedCommentIds: normalizeIds(parsed.addressed_comment_ids ?? parsed.addressedCommentIds),
          stillApplies: normalizeStillApplies(parsed.still_applies ?? parsed.stillApplies),
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return { summary: trimmed, findings: [], addressedCommentIds: [], stillApplies: [] };
}

export function toReviewComments(findings, locations, { includeModel = false } = {}) {
  const mapped = [];
  const unmapped = [];

  for (const finding of findings) {
    const anchor = resolveCommentAnchor(locations, finding);
    if (!anchor) {
      unmapped.push(finding);
      continue;
    }
    const comment = {
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
  const comments = mapped.slice(0, maxComments).map((item) => item.comment);
  const overflow = mapped.slice(maxComments).map((item) => item.finding);
  return { comments, unmapped, overflow };
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
}) {
  const piVersion = process.env.PI_VERSION || "0.84.2";
  const footer = `\n\n---\n<sub>Reviewed ${shortSha(headSha)} with Pi ${piVersion} using ${modelLabels}.</sub>`;
  const hasFindings = unmapped.length > 0 || overflow.length > 0 || severities.length > 0;
  const modelSummary = String(summary ?? "").trim();
  let overview;
  if (clean) {
    overview = modelSummary && modelSummary !== "No new findings."
      ? `No new findings.\n\n${modelSummary}`
      : "No new findings.";
  } else {
    overview = modelSummary || (hasFindings ? "See inline comments." : "No new findings.");
  }
  const parts = ["## Pi code review", "", overview];
  const tally = clean ? "" : tallyLine(severities);
  if (tally) parts.push("", tally);
  appendFindingList(parts, overflow, "### Additional findings (GitHub limit 100)");
  appendFindingList(parts, unmapped, "### Could not attach to the diff");

  const review = parts.join("\n");
  const maxLength = maxReviewChars - marker.length - footer.length;
  const safeReview = review.length > maxLength
    ? `${review.slice(0, maxLength)}\n\n_Review output was truncated._`
    : review;
  return `${marker}\n${safeReview}${footer}`;
}

export function formatInlineComment(finding, includeModel = false) {
  const severity = finding.severity || "Low";
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

function normalizeIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((value) => Number(value)).filter((id) => Number.isSafeInteger(id) && id > 0))];
}

function normalizeStillApplies(raw) {
  if (!Array.isArray(raw)) return [];
  const items = [];
  for (const entry of raw) {
    const value = typeof entry === "number" || typeof entry === "string" ? { id: entry } : entry;
    if (!value || typeof value !== "object") continue;
    const id = Number(value.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const path = normalizePath(value.path ?? "");
    const line = Number(value.line);
    if (path && Number.isSafeInteger(line) && line > 0) {
      items.push({
        id,
        path,
        line,
        side: normalizeSide(value.side) || "RIGHT",
        severity: value.severity ? normalizeSeverity(value.severity) : undefined,
        body: String(value.body ?? "").trim(),
      });
    } else {
      items.push({ id });
    }
  }
  return items;
}

function normalizeFinding(raw) {
  if (!raw || typeof raw !== "object") return null;
  const path = normalizePath(raw.path ?? raw.file ?? raw.filename ?? "");
  const body = String(raw.body ?? raw.comment ?? raw.message ?? raw.text ?? "").trim();
  const line = Number(raw.line ?? raw.line_number ?? raw.lineNumber);
  if (!path || !body || !Number.isSafeInteger(line) || line <= 0) return null;
  return {
    severity: normalizeSeverity(raw.severity),
    path,
    line,
    side: normalizeSide(raw.side) || "RIGHT",
    start_line: raw.start_line ?? raw.startLine,
    body,
    modelLabel: raw.modelLabel,
  };
}

function normalizeSeverity(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "critical") return "Critical";
  if (text === "high") return "High";
  if (text === "medium") return "Medium";
  if (text === "low") return "Low";
  return "Low";
}

function appendFindingList(parts, findings, heading) {
  if (!findings.length) return;
  parts.push("", heading, "");
  for (const finding of findings) {
    const place = finding.line ? `${finding.path}:${finding.line}` : finding.path;
    parts.push(`- **${finding.severity || "Low"}** \`${place}\` — ${finding.body}`);
  }
}

function shortSha(sha) {
  return String(sha ?? "").slice(0, 7);
}
