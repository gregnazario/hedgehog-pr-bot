export const SKIP_REVIEW_LABEL = "skip-review";
export const CHECK_NAME = "Pi review";
export const STILL_APPLIES_REPLY = "Still applies.";

const severityRank = { Critical: 0, High: 1, Medium: 2, Low: 3 };

export function hasSkipReviewLabel(labels) {
  return (labels ?? []).some((label) => {
    const name = typeof label === "string" ? label : label?.name;
    return String(name ?? "").toLowerCase() === SKIP_REVIEW_LABEL;
  });
}

export function isReviewCommand(body) {
  const token = String(body ?? "").trim().split(/\s+/)[0];
  return token === "/review";
}

export function isHedgehogLogin(login) {
  return String(login ?? "").replace(/\[bot\]$/i, "") === "hedgehog-pr-bot";
}

export function reviewHasCurrentMarker(reviews, marker) {
  if (!marker) return false;
  return (reviews ?? []).some((review) => (
    review.body?.startsWith(marker) && (review.user?.type === "Bot" || isHedgehogLogin(review.user?.login))
  ));
}

export function parseSeverityPrefix(body) {
  const match = String(body ?? "").match(/\*\*(Critical|High|Medium|Low):\*\*/i);
  if (!match) return "Low";
  return normalizeSeverity(match[1]);
}

export function applyThreadDecisions({ findings = [], addressedCommentIds = [], stillApplies = [], threads = [] }) {
  const byId = new Map(threads.map((thread) => [thread.commentId, thread]));
  const stillIds = new Set(
    stillApplies.map((item) => item?.id).filter((id) => byId.has(id)),
  );

  const addressed = addressedCommentIds
    .filter((id) => byId.has(id) && !stillIds.has(id))
    .map((id) => byId.get(id));

  const stillReplies = [];
  const movedFindings = [];
  for (const item of stillApplies) {
    const thread = byId.get(item?.id);
    if (!thread) continue;
    if (item.path && Number.isSafeInteger(Number(item.line)) && Number(item.line) > 0) {
      movedFindings.push({
        severity: item.severity ? normalizeSeverity(item.severity) : thread.severity,
        path: item.path,
        line: Number(item.line),
        side: item.side || thread.side || "RIGHT",
        body: String(item.body ?? "").trim() || thread.body,
      });
    } else {
      stillReplies.push(thread);
    }
  }

  const occupied = new Set();
  for (const thread of stillReplies) occupied.add(locationKey(thread.path, thread.side, thread.line));
  for (const finding of movedFindings) occupied.add(locationKey(finding.path, finding.side, finding.line));

  const newFindings = findings.filter((finding) => !occupied.has(locationKey(finding.path, finding.side, finding.line)));
  return { newFindings, movedFindings, stillReplies, addressed };
}

export function collectSeverities({ newFindings = [], movedFindings = [], stillReplies = [] }) {
  return [
    ...newFindings,
    ...movedFindings,
    ...stillReplies,
  ].map((item) => normalizeSeverity(item.severity));
}

export function reviewEventFromSeverities(severities) {
  if (!severities.length) return "APPROVE";
  if (severities.some((severity) => severity === "Critical" || severity === "High")) return "REQUEST_CHANGES";
  return "COMMENT";
}

export function tallyLine(severities) {
  const counts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  for (const severity of severities) {
    const key = normalizeSeverity(severity);
    if (key in counts) counts[key] += 1;
  }
  const parts = [];
  for (const name of ["Critical", "High", "Medium", "Low"]) {
    if (!counts[name]) continue;
    const icon = severityRank[name] <= 1 ? "⚠️" : "ℹ️";
    parts.push(`${icon} ${counts[name]} ${name}`);
  }
  return parts.join(" · ");
}

export function checkOutcome({ failed = false, errorMessage = "", severities = [] } = {}) {
  if (failed) {
    const detail = sanitizeCheckText(errorMessage);
    return {
      conclusion: "failure",
      title: "❌ Review failed",
      summary: detail ? `\`\`\`\n${detail}\n\`\`\`` : "Review failed.",
    };
  }
  const high = severities.filter((severity) => severity === "Critical" || severity === "High").length;
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

function locationKey(path, side, line) {
  return `${path}\0${side || "RIGHT"}\0${line}`;
}

export function sanitizeCheckText(text, limit = 500) {
  const cleaned = String(text ?? "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replaceAll("```", "")
    .trim();
  return cleaned.slice(0, limit);
}

function normalizeSeverity(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "critical") return "Critical";
  if (text === "high") return "High";
  if (text === "medium") return "Medium";
  if (text === "low") return "Low";
  return "Low";
}
