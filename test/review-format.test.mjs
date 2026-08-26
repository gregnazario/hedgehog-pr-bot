import assert from "node:assert/strict";
import test from "node:test";
import { indexDiffLocations } from "../src/diff.mjs";
import {
  buildReviewBody,
  parseReviewOutput,
  toReviewComments,
} from "../src/review-format.mjs";

const diff = `diff --git a/src/app.mjs b/src/app.mjs
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,3 +1,4 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
+export const VERSION = 1;
`;

test("parses a JSON review object", () => {
  const parsed = parseReviewOutput(JSON.stringify({
    summary: "One arithmetic bug.",
    findings: [{
      severity: "High",
      path: "src/app.mjs",
      line: 2,
      side: "RIGHT",
      body: "This used to subtract.",
    }],
  }));
  assert.equal(parsed.summary, "One arithmetic bug.");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].path, "src/app.mjs");
  assert.equal(parsed.findings[0].line, 2);
  assert.equal(parsed.findings[0].side, "RIGHT");
});

test("parses JSON wrapped in a markdown fence and extra prose", () => {
  const parsed = parseReviewOutput(`Here is the review:\n\`\`\`json\n{"summary":"Looks good.","findings":[]}\n\`\`\`\n`);
  assert.equal(parsed.summary, "Looks good.");
  assert.deepEqual(parsed.findings, []);
});

test("treats non-JSON output as a summary with no findings", () => {
  const parsed = parseReviewOutput("## Pi code review\n\nNo actionable issues found.");
  assert.match(parsed.summary, /No actionable issues found/);
  assert.equal(parsed.findings.length, 0);
});

test("accepts alternate finding field names", () => {
  const parsed = parseReviewOutput(JSON.stringify({
    summary: "Note",
    findings: [{
      severity: "medium",
      file: "src/app.mjs",
      line_number: "4",
      side: "+",
      comment: "Version bump needs a changelog.",
    }],
  }));
  assert.equal(parsed.findings[0].path, "src/app.mjs");
  assert.equal(parsed.findings[0].line, 4);
  assert.equal(parsed.findings[0].side, "RIGHT");
  assert.equal(parsed.findings[0].body, "Version bump needs a changelog.");
  assert.equal(parsed.findings[0].severity, "Medium");
});

test("maps findings onto GitHub review comments for diff lines", () => {
  const parsed = parseReviewOutput(JSON.stringify({
    summary: "Check the new export.",
    findings: [{
      severity: "Low",
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
      body: "Is this used?",
    }],
  }));
  const { comments, unmapped } = toReviewComments(parsed.findings, indexDiffLocations(diff));
  assert.equal(unmapped.length, 0);
  assert.deepEqual(comments, [{
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: "**Low:** Is this used?",
  }]);
});

test("leaves unmapped findings out of the inline comment list", () => {
  const parsed = parseReviewOutput(JSON.stringify({
    summary: "Two notes.",
    findings: [
      { severity: "High", path: "src/app.mjs", line: 4, side: "RIGHT", body: "On the diff." },
      { severity: "High", path: "README.md", line: 1, side: "RIGHT", body: "Not in this PR." },
    ],
  }));
  const { comments, unmapped } = toReviewComments(parsed.findings, indexDiffLocations(diff));
  assert.equal(comments.length, 1);
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].path, "README.md");
});

test("prefixes comments with the model label when several models ran", () => {
  const findings = [{
    severity: "High",
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: "Check this export.",
    modelLabel: "zai/glm-5.3:high",
  }];
  const { comments } = toReviewComments(findings, indexDiffLocations(diff), { includeModel: true });
  assert.match(comments[0].body, /zai\/glm-5\.3:high/);
  assert.match(comments[0].body, /Check this export/);
});

test("keeps the 100-comment GitHub limit and prefers higher severity", () => {
  const findings = Array.from({ length: 120 }, (_, index) => ({
    severity: index < 5 ? "Critical" : "Low",
    path: "src/app.mjs",
    line: 4,
    side: "RIGHT",
    body: `Finding ${index}`,
  }));
  const { comments, unmapped } = toReviewComments(findings, indexDiffLocations(diff));
  assert.equal(comments.length, 100);
  assert.equal(unmapped.length, 20);
  assert.equal(comments.filter((comment) => comment.body.startsWith("**Critical:**")).length, 5);
});

test("builds a review body with the marker, summary, and footer", () => {
  const body = buildReviewBody({
    marker: "<!-- greg-pr-bot-review head:123 config:abc -->",
    summary: "Looks good.",
    commentCount: 2,
    unmapped: [],
    headSha: "1234567dead",
    modelLabels: "zai/glm-5.3:high",
  });
  assert.match(body, /^<!-- greg-pr-bot-review head:123 config:abc -->/);
  assert.match(body, /Looks good/);
  assert.match(body, /2 inline comments/);
  assert.match(body, /Reviewed 1234567/);
});

test("includes unmapped notes in the review summary", () => {
  const body = buildReviewBody({
    marker: "<!-- greg-pr-bot-review head:123 config:abc -->",
    summary: "Mostly inline.",
    commentCount: 1,
    unmapped: [{ severity: "High", path: "README.md", line: 3, body: "Mention the flag." }],
    headSha: "1234567dead",
    modelLabels: "zai/glm-5.3:high",
  });
  assert.match(body, /Could not attach to the diff/);
  assert.match(body, /README\.md:3/);
  assert.match(body, /Mention the flag/);
});
