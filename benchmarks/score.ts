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

const MATCH_RADIUS = 6;

const sameSpot = (finding: BenchFinding, truth: BenchTruth): boolean =>
  finding.path === truth.path && Math.abs(finding.line - truth.line) <= MATCH_RADIUS;

export function scoreCase(
  findings: readonly BenchFinding[],
  truth: readonly BenchTruth[],
): CaseScore {
  const findingsMatched = findings.filter((finding) =>
    truth.some((item) => sameSpot(finding, item)),
  ).length;
  const truthsFound = truth.filter((item) =>
    findings.some((finding) => sameSpot(finding, item)),
  ).length;
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
