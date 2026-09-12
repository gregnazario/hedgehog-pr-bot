export interface BenchFinding {
  path: string;
  line: number;
}

export interface BenchTruth {
  path: string;
  line: number;
  class: string;
}

export interface CaseScore {
  truthsFound: number;
  truthsTotal: number;
  findingsMatched: number;
  findingsTotal: number;
}

const MATCH_RADIUS = 4;

/** Greedy one-to-one assignment: each truth consumes at most the nearest
 * finding, so duplicate comments on one bug count as precision misses. */
export function assignMatches(
  findings: readonly BenchFinding[],
  truth: readonly BenchTruth[],
): { truthsFound: number; findingsMatched: number } {
  const candidates = truth.flatMap((item) =>
    findings
      .filter(
        (finding) =>
          finding.path === item.path && Math.abs(finding.line - item.line) <= MATCH_RADIUS,
      )
      .map((finding) => ({ finding, truth: item, distance: Math.abs(finding.line - item.line) })),
  );
  candidates.sort((left, right) => left.distance - right.distance);
  const usedFindings = new Set<BenchFinding>();
  const usedTruths = new Set<BenchTruth>();
  for (const candidate of candidates) {
    if (usedFindings.has(candidate.finding) || usedTruths.has(candidate.truth)) continue;
    usedFindings.add(candidate.finding);
    usedTruths.add(candidate.truth);
  }
  return { truthsFound: usedTruths.size, findingsMatched: usedFindings.size };
}

export function scoreCase(
  findings: readonly BenchFinding[],
  truth: readonly BenchTruth[],
): CaseScore {
  const { truthsFound, findingsMatched } = assignMatches(findings, truth);
  return {
    truthsFound,
    truthsTotal: truth.length,
    findingsMatched,
    findingsTotal: findings.length,
  };
}

export interface Totals {
  recall: number;
  precision: number;
  truthsFound: number;
  truthsTotal: number;
  findingsMatched: number;
  findingsTotal: number;
  cleanCaseFindings: number;
}

export function totalScores(cases: readonly { clean: boolean; score: CaseScore }[]): Totals {
  const buggy = cases.filter((entry) => !entry.clean);
  const truthsFound = buggy.reduce((sum, entry) => sum + entry.score.truthsFound, 0);
  const truthsTotal = buggy.reduce((sum, entry) => sum + entry.score.truthsTotal, 0);
  const findingsMatched = buggy.reduce((sum, entry) => sum + entry.score.findingsMatched, 0);
  const findingsTotal = buggy.reduce((sum, entry) => sum + entry.score.findingsTotal, 0);
  return {
    recall: truthsTotal === 0 ? 0 : truthsFound / truthsTotal,
    precision: findingsTotal === 0 ? 1 : findingsMatched / findingsTotal,
    truthsFound,
    truthsTotal,
    findingsMatched,
    findingsTotal,
    cleanCaseFindings: cases
      .filter((entry) => entry.clean)
      .reduce((sum, entry) => sum + entry.score.findingsTotal, 0),
  };
}

export interface PostedReviewLike {
  body?: string;
  comments?: Array<{ path: string; line: number }>;
}

/** Extracts findings from a posted review: inline comments plus the unmapped
 * list rendered into the body (`- **Sev** \`path:line\` — …`). Kept beside
 * the scorer so a review-body format change breaks the unit test, not the
 * benchmark numbers. */
export function extractFindings(posted: PostedReviewLike): BenchFinding[] {
  const inline = (posted.comments ?? []).map((comment) => ({
    path: comment.path,
    line: comment.line,
  }));
  // The review body renders unmapped findings as: - **Sev** `path:line` — …
  const pattern = new RegExp(String.raw`- \*\*\w+\*\* ` + "`([^`:+]+):(\\d+)`", "g");
  const bodyList = [...String(posted.body ?? "").matchAll(pattern)].map((match) => ({
    path: match[1],
    line: Number(match[2]),
  }));
  return [...inline, ...bodyList];
}
