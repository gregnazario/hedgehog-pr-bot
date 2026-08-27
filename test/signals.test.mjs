import assert from "node:assert/strict";
import test from "node:test";
import {
  CHECK_NAME,
  SKIP_REVIEW_LABEL,
  STILL_APPLIES_REPLY,
  applyThreadDecisions,
  checkOutcome,
  hasSkipReviewLabel,
  isHedgehogLogin,
  isReviewCommand,
  parseSeverityPrefix,
  reviewEventFromSeverities,
  tallyLine,
} from "../src/signals.mjs";

test("skip-review matches label names case-insensitively", () => {
  assert.equal(SKIP_REVIEW_LABEL, "skip-review");
  assert.equal(hasSkipReviewLabel([{ name: "skip-review" }]), true);
  assert.equal(hasSkipReviewLabel([{ name: "Skip-Review" }]), true);
  assert.equal(hasSkipReviewLabel(["skip-review"]), true);
  assert.equal(hasSkipReviewLabel([{ name: "needs-review" }]), false);
  assert.equal(hasSkipReviewLabel([]), false);
});

test("review command matches only the first token /review", () => {
  assert.equal(isReviewCommand("/review"), true);
  assert.equal(isReviewCommand("  /review please"), true);
  assert.equal(isReviewCommand("/review-foo"), false);
  assert.equal(isReviewCommand("please /review"), false);
  assert.equal(isReviewCommand(""), false);
});

test("hedgehog login matches the GitHub App bot account", () => {
  assert.equal(isHedgehogLogin("hedgehog-pr-bot[bot]"), true);
  assert.equal(isHedgehogLogin("hedgehog-pr-bot"), true);
  assert.equal(isHedgehogLogin("cursor[bot]"), false);
  assert.equal(isHedgehogLogin("gregnazario"), false);
});

test("severity prefix is read from hedgehog comment bodies", () => {
  assert.equal(parseSeverityPrefix("**High:** missing auth"), "High");
  assert.equal(parseSeverityPrefix("_zai/glm-5.3:high_\n\n**Critical:** leak"), "Critical");
  assert.equal(parseSeverityPrefix("no prefix"), "Low");
});

test("thread decisions resolve, reply, move, and drop unknown ids", () => {
  const threads = [
    { commentId: 101, threadId: "T101", path: "a.mjs", line: 1, side: "RIGHT", severity: "High", body: "**High:** old" },
    { commentId: 202, threadId: "T202", path: "b.mjs", line: 2, side: "RIGHT", severity: "Low", body: "**Low:** still" },
    { commentId: 303, threadId: "T303", path: "c.mjs", line: 3, side: "RIGHT", severity: "Medium", body: "**Medium:** moved" },
  ];
  const result = applyThreadDecisions({
    findings: [
      { severity: "Low", path: "b.mjs", line: 2, side: "RIGHT", body: "duplicate" },
      { severity: "Low", path: "d.mjs", line: 9, side: "RIGHT", body: "new" },
    ],
    addressedCommentIds: [101, 999],
    stillApplies: [
      { id: 202 },
      { id: 303, path: "c2.mjs", line: 40, side: "RIGHT", severity: "Medium", body: "now here" },
      { id: 888 },
    ],
    threads,
  });
  assert.deepEqual(result.addressed.map((thread) => thread.commentId), [101]);
  assert.deepEqual(result.stillReplies.map((thread) => thread.commentId), [202]);
  assert.deepEqual(result.movedFindings, [{
    severity: "Medium",
    path: "c2.mjs",
    line: 40,
    side: "RIGHT",
    body: "now here",
  }]);
  assert.deepEqual(result.newFindings, [{
    severity: "Low",
    path: "d.mjs",
    line: 9,
    side: "RIGHT",
    body: "new",
  }]);
});

test("review event follows clean / high / medium-low rules", () => {
  assert.equal(reviewEventFromSeverities([]), "APPROVE");
  assert.equal(reviewEventFromSeverities(["High"]), "REQUEST_CHANGES");
  assert.equal(reviewEventFromSeverities(["Critical", "Low"]), "REQUEST_CHANGES");
  assert.equal(reviewEventFromSeverities(["Medium", "Low"]), "COMMENT");
});

test("tally line omits zero counts and is empty when clean", () => {
  assert.equal(tallyLine([]), "");
  assert.equal(tallyLine(["High", "Low", "Low"]), "⚠️ 1 High · ℹ️ 2 Low");
  assert.equal(tallyLine(["Critical", "Medium"]), "⚠️ 1 Critical · ℹ️ 1 Medium");
});

test("check outcome never fails on findings", () => {
  assert.equal(CHECK_NAME, "Pi review");
  assert.equal(STILL_APPLIES_REPLY, "Still applies.");
  assert.deepEqual(checkOutcome({ failed: true, errorMessage: "Pi exited" }), {
    conclusion: "failure",
    title: "❌ Review failed",
    summary: "Pi exited",
  });
  assert.equal(checkOutcome({ severities: ["High", "Low"] }).conclusion, "action_required");
  assert.match(checkOutcome({ severities: ["High", "Low"] }).title, /⚠️ 1 high\/critical/);
  assert.equal(checkOutcome({ severities: ["Medium"] }).conclusion, "success");
  assert.match(checkOutcome({ severities: ["Medium"] }).title, /ℹ️ 1 comments/);
  assert.deepEqual(checkOutcome({ severities: [] }), {
    conclusion: "success",
    title: "✅ No new findings",
    summary: "No new findings.",
  });
});
