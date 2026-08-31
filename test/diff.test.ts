import assert from "node:assert/strict";
import test from "node:test";
import {
  annotateDiff,
  diffFromPullRequestFiles,
  indexDiffLocations,
  resolveCommentAnchor,
} from "../src/diff.ts";

const modifiedDiff = `diff --git a/src/app.mjs b/src/app.mjs
index 111..222 100644
--- a/src/app.mjs
+++ b/src/app.mjs
@@ -1,3 +1,4 @@
 export function add(a, b) {
-  return a - b;
+  return a + b;
 }
+export const VERSION = 1;
`;

test("indexes added lines on the RIGHT and deleted lines on the LEFT", () => {
  const locations = indexDiffLocations(modifiedDiff);
  assert.equal(locations.has("src/app.mjs", "RIGHT", 2), true);
  assert.equal(locations.has("src/app.mjs", "LEFT", 2), true);
  assert.equal(locations.has("src/app.mjs", "RIGHT", 4), true);
  assert.equal(locations.has("src/app.mjs", "RIGHT", 99), false);
});

test("indexes a deleted file on the LEFT using the old path", () => {
  const diff = `diff --git a/gone.mjs b/gone.mjs
deleted file mode 100644
--- a/gone.mjs
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export default gone;
`;
  const locations = indexDiffLocations(diff);
  assert.equal(locations.has("gone.mjs", "LEFT", 1), true);
  assert.equal(locations.has("gone.mjs", "LEFT", 2), true);
  assert.equal(locations.has("gone.mjs", "RIGHT", 1), false);
});

test("indexes a new file on the RIGHT", () => {
  const diff = `diff --git a/new.mjs b/new.mjs
new file mode 100644
--- /dev/null
+++ b/new.mjs
@@ -0,0 +1,2 @@
+export const n = 1;
+export const m = 2;
`;
  const locations = indexDiffLocations(diff);
  assert.equal(locations.has("new.mjs", "RIGHT", 1), true);
  assert.equal(locations.has("new.mjs", "RIGHT", 2), true);
});

test("comments on renamed files use the new path", () => {
  const diff = `diff --git a/old.mjs b/new.mjs
similarity index 80%
rename from old.mjs
rename to new.mjs
--- a/old.mjs
+++ b/new.mjs
@@ -1,2 +1,2 @@
-export const name = "old";
+export const name = "new";
 export default name;
`;
  const locations = indexDiffLocations(diff);
  assert.equal(locations.has("new.mjs", "RIGHT", 1), true);
  assert.equal(locations.resolvePath("old.mjs"), "new.mjs");
});

test("annotates hunk lines with LEFT/RIGHT file numbers", () => {
  const annotated = annotateDiff(modifiedDiff);
  assert.match(annotated, /\[RIGHT 2\] \+ {2}return a \+ b;/);
  assert.match(annotated, /\[LEFT 2\] - {2}return a - b;/);
  assert.match(annotated, /\[RIGHT 4\] \+export const VERSION = 1;/);
});

test("resolves a comment to an exact diff line", () => {
  const locations = indexDiffLocations(modifiedDiff);
  assert.deepEqual(
    resolveCommentAnchor(locations, { path: "src/app.mjs", line: 4, side: "RIGHT" }),
    {
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
    },
  );
});

test("snaps a nearby line onto the same file and side", () => {
  const locations = indexDiffLocations(modifiedDiff);
  const anchor = resolveCommentAnchor(locations, { path: "src/app.mjs", line: 5, side: "RIGHT" });
  assert.ok(anchor);
  assert.equal(anchor.path, "src/app.mjs");
  assert.equal(anchor.side, "RIGHT");
  assert.equal(anchor.line, 4);
});

test("snaps an equidistant request to the smaller line number", () => {
  const diff = `diff --git a/tie.mjs b/tie.mjs
--- a/tie.mjs
+++ b/tie.mjs
@@ -1,1 +1,1 @@
 first
@@ -9,1 +9,1 @@
 ninth
`;
  const locations = indexDiffLocations(diff);
  const anchor = resolveCommentAnchor(locations, { path: "tie.mjs", line: 5, side: "RIGHT" });
  assert.ok(anchor);
  assert.equal(anchor.side, "RIGHT");
  assert.equal(anchor.line, 1);
});

test("uses an exact line on the other side before snapping", () => {
  const diff = `diff --git a/gone.mjs b/gone.mjs
deleted file mode 100644
--- a/gone.mjs
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export default gone;
`;
  const locations = indexDiffLocations(diff);
  assert.deepEqual(resolveCommentAnchor(locations, { path: "gone.mjs", line: 2, side: "RIGHT" }), {
    path: "gone.mjs",
    line: 2,
    side: "LEFT",
  });
});

test("keeps comments on a single line even when start_line is present", () => {
  const locations = indexDiffLocations(modifiedDiff);
  assert.deepEqual(
    resolveCommentAnchor(locations, {
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
      start_line: 1,
    }),
    {
      path: "src/app.mjs",
      line: 4,
      side: "RIGHT",
    },
  );
});

test("returns null when the file is not in the diff", () => {
  const locations = indexDiffLocations(modifiedDiff);
  assert.equal(
    resolveCommentAnchor(locations, { path: "missing.mjs", line: 1, side: "RIGHT" }),
    null,
  );
});

test("diffFromPullRequestFiles rebuilds a diff the indexer understands", () => {
  const diff = diffFromPullRequestFiles([
    {
      filename: "src/app.mjs",
      status: "modified",
      patch: "@@ -1,2 +1,3 @@\n old line\n-new line\n+new line\n+added line",
    },
    {
      filename: "renamed.mjs",
      previous_filename: "old.mjs",
      status: "renamed",
      patch: "@@ -1,1 +1,1 @@\n-const a = 1;\n+const a = 2;",
    },
    { filename: "gone.mjs", status: "removed", patch: "@@ -1,1 +0,0 @@\n-deleted body" },
    { filename: "new.mjs", status: "added", patch: "@@ -0,0 +1,1 @@\n+created" },
    { filename: "binary.png", status: "modified", patch: null },
  ]);
  const locations = indexDiffLocations(diff);
  assert.equal(locations.has("src/app.mjs", "RIGHT", 2), true);
  assert.equal(locations.has("src/app.mjs", "LEFT", 1), true);
  assert.equal(locations.resolvePath("old.mjs"), "renamed.mjs");
  assert.equal(locations.has("renamed.mjs", "RIGHT", 1), true);
  assert.equal(locations.has("gone.mjs", "LEFT", 1), true);
  assert.equal(locations.has("new.mjs", "RIGHT", 1), true);
  assert.match(annotateDiff(diff), /\[RIGHT 3\] \+added line/);
});
