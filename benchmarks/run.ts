// Runs the real review pipeline over the benchmark corpus and scores it.
//   node benchmarks/run.ts          real model passes (needs Pi + API keys)
//   node benchmarks/run.ts --dry    harness check with stubbed models
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadReviewConfig } from "../src/config.ts";
import { reviewPullRequest } from "../src/reviewer.ts";
import type { ReviewConfig, ReviewSubmission } from "../src/types.ts";
import { extractFindings, scoreCase, totalScores } from "./score.ts";

interface BenchCase {
  name: string;
  title: string;
  clean: boolean;
  truth: Array<{ path: string; anchor: string; class: string; note: string; line: number }>;
}

interface CaseResult {
  name: string;
  title: string;
  clean: boolean;
  findings: ReturnType<typeof extractFindings>;
  score: ReturnType<typeof scoreCase>;
  error?: string;
}

const casesRoot = new URL("./cases/", import.meta.url).pathname;
const dry = process.argv.includes("--dry");

const config: ReviewConfig = {
  ...loadReviewConfig(),
  // The corpus is diff-only by construction; production adds touched-file
  // contents on top, so this run measures the weaker configuration.
  fileContextBytes: 0,
};

const loadCases = (): Array<BenchCase & { diff: string }> => {
  const out: Array<BenchCase & { diff: string }> = [];
  for (const entry of readdirSync(casesRoot).sort()) {
    const dir = join(casesRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    const bench = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as BenchCase;
    out.push({ ...bench, diff: readFileSync(join(dir, "diff.patch"), "utf8") });
  }
  return out;
};

const fakeClient = (bench: BenchCase & { diff: string }) => {
  let posted: ReviewSubmission | undefined;
  return {
    posted: () => posted,
    client: {
      getPullRequest: async () => ({
        number: 1,
        state: "open",
        title: bench.title,
        body: "No description provided.",
        user: { login: "gregnazario" },
        head: { sha: "bench000000", ref: "bench" },
        base: { ref: "main" },
      }),
      getPullRequestDiff: async () => bench.diff,
      listPullRequestReviews: async () => [],
      createPullRequestReview: async (
        _fullName: string,
        _number: number,
        payload: ReviewSubmission,
      ) => {
        posted = payload;
        return { id: 1 };
      },
    },
  };
};

let failed = 0;

const run = async (): Promise<void> => {
  const cases = loadCases();
  const results: CaseResult[] = [];
  for (const bench of cases) {
    process.stderr.write(
      `running ${bench.name} (${bench.clean ? "clean" : `${bench.truth.length} bug(s)`})… `,
    );
    const { client, posted } = fakeClient(bench);
    try {
      await reviewPullRequest({
        client,
        fullName: "bench/corpus",
        number: 1,
        config,
        ...(dry
          ? {
              runModel: async () => JSON.stringify({ summary: "Dry run.", findings: [] }),
              verifyModel: async () => '{"verdicts":[]}',
            }
          : {}),
        logger: {
          log() {},
          error: (...args: unknown[]) => process.stderr.write(`${args.join(" ")}\n`),
        },
      });
    } catch (error) {
      failed += 1;
      process.stderr.write(`FAILED: ${(error as Error).message}\n`);
      results.push({
        name: bench.name,
        title: bench.title,
        clean: bench.clean,
        findings: [],
        score: {
          truthsFound: 0,
          truthsTotal: bench.truth.length,
          findingsMatched: 0,
          findingsTotal: 0,
        },
        error: (error as Error).message,
      });
      continue;
    }
    const findings = extractFindings(posted() ?? {});
    const score = scoreCase(
      findings,
      bench.truth.map((item) => ({ path: item.path, line: item.line, class: item.class })),
    );
    results.push({ name: bench.name, title: bench.title, clean: bench.clean, findings, score });
    process.stderr.write(
      `${score.truthsFound}/${score.truthsTotal} bugs, ${score.findingsTotal} finding(s)\n`,
    );
  }

  const totals = totalScores(results);
  const errored = results.filter((r) => r.error);
  const lines = [
    "# hedgehog-pr-bot benchmark",
    "",
    `- date: ${new Date().toISOString()}`,
    `- model(s): ${config.models.map((spec) => spec.label).join(", ")}${dry ? " (dry run — stubbed models)" : ""}`,
    `- cases: ${results.length} (${results.filter((r) => !r.clean).length} with planted bugs, ${results.filter((r) => r.clean).length} clean)`,
    `- verification pass: ${config.verifyFindings !== false ? "on" : "off"}; file context: off (diff-only corpus)`,
    "",
    "## Totals",
    "",
    `- **recall: ${(totals.recall * 100).toFixed(0)}%** (${totals.truthsFound}/${totals.truthsTotal} planted bugs found)`,
    `- **precision: ${(totals.precision * 100).toFixed(0)}%** (${totals.findingsMatched}/${totals.findingsTotal} findings matched a planted bug)`,
    `- clean-case findings (false positives): **${totals.cleanCaseFindings}**`,
    `- case failures (pipeline errors, excluded from metrics): **${errored.length}**`,
    "",
    "## Per case",
    "",
    "| case | bugs found | findings | matched | notes |",
    "| --- | ---: | ---: | ---: | --- |",
    ...results.map(
      (r) =>
        `| ${r.name}${r.clean ? " *(clean)*" : ""} | ${r.clean ? "—" : `${r.score.truthsFound}/${r.score.truthsTotal}`} | ${r.score.findingsTotal} | ${r.score.findingsMatched} | ${r.error ? `**error:** ${r.error.replaceAll("|", "\\|").slice(0, 80)}` : ""} |`,
    ),
    "",
    "## Findings detail",
    "",
    ...results.flatMap((r) =>
      r.findings.length === 0
        ? []
        : [`### ${r.name}`, "", ...r.findings.map((f) => `- \`${f.path}:${f.line}\``), ""],
    ),
  ];
  const report = lines.join("\n");
  const root = new URL("./", import.meta.url).pathname;
  mkdirSync(join(root, "reports"), { recursive: true });
  const stamp = new Date().toISOString().replace("T", "-").slice(0, 16);
  const file = join(root, "reports", `${stamp}${dry ? "-dry" : ""}.md`);
  writeFileSync(file, `${report}\n`);
  console.log(report);
  console.log(`\nreport written to ${file}`);
  if (failed > 0) process.exitCode = 1;
};

await run();
