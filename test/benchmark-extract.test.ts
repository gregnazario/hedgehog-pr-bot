import assert from "node:assert/strict";
import test from "node:test";
import { extractFindings } from "../benchmarks/score.ts";

test("extractFindings parses inline comments and body-listed unmapped findings", () => {
  const posted = {
    body: [
      "## Pi code review",
      "",
      "overview",
      "",
      "### Could not attach to the diff",
      "",
      "- **High** `src/other.ts:12` — cannot map",
      "- **Low** `src/gone.ts:3` — deleted line",
    ].join("\n"),
    comments: [{ path: "src/app.ts", line: 4 }],
  };
  assert.deepEqual(extractFindings(posted), [
    { path: "src/app.ts", line: 4 },
    { path: "src/other.ts", line: 12 },
    { path: "src/gone.ts", line: 3 },
  ]);
});
