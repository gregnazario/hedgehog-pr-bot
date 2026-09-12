import assert from "node:assert/strict";
import test from "node:test";
import { scoreCase, totalScores } from "../benchmarks/score.ts";

test("scoreCase matches findings to truths by path and radius", () => {
  const truth = [
    { path: "a.ts", line: 10, class: "security" },
    { path: "b.ts", line: 30, class: "correctness" },
  ];
  const score = scoreCase(
    [
      { path: "a.ts", line: 14 },
      { path: "a.ts", line: 40 },
      { path: "c.ts", line: 10 },
    ],
    truth,
  );
  assert.equal(score.truthsFound, 1);
  assert.equal(score.truthsTotal, 2);
  assert.equal(score.findingsMatched, 1);
  assert.equal(score.findingsTotal, 3);
});

test("totals aggregate recall, precision, and clean-case noise", () => {
  const totals = totalScores([
    {
      clean: false,
      score: { truthsFound: 1, truthsTotal: 2, findingsMatched: 1, findingsTotal: 2 },
    },
    {
      clean: false,
      score: { truthsFound: 1, truthsTotal: 2, findingsMatched: 1, findingsTotal: 1 },
    },
    {
      clean: true,
      score: { truthsFound: 0, truthsTotal: 0, findingsMatched: 0, findingsTotal: 3 },
    },
  ]);
  assert.equal(totals.recall, 0.5);
  assert.equal(totals.precision, 2 / 3);
  assert.equal(totals.cleanCaseFindings, 3);
});

test("duplicate findings on one bug count as precision misses", () => {
  const score = scoreCase(
    [
      { path: "a.ts", line: 10 },
      { path: "a.ts", line: 11 },
      { path: "a.ts", line: 12 },
    ],
    [{ path: "a.ts", line: 10, class: "security" }],
  );
  assert.equal(score.truthsFound, 1);
  assert.equal(score.findingsMatched, 1);
  assert.equal(score.findingsTotal, 3);
});

test("radius is tight enough to miss distant same-file findings", () => {
  const score = scoreCase([{ path: "a.ts", line: 10 }], [{ path: "a.ts", line: 20, class: "x" }]);
  assert.equal(score.truthsFound, 0);
});
