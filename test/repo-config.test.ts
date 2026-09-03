import assert from "node:assert/strict";
import test from "node:test";
import { parseRepoConfig, repoConfigDrops } from "../src/repo-config.ts";

test("parses the documented .hedgehog.yml schema", () => {
  const config = parseRepoConfig(`
# hedgehog config
skip: false
ignore_paths: [dist/, "vendor/pkg", 'gen']
min_severity: Medium
verify: false
future_key: ignored
`);
  assert.deepEqual(config, {
    skip: false,
    ignorePaths: ["dist", "vendor/pkg", "gen"],
    minSeverity: "Medium",
    verify: false,
  });
});

test("parses block lists and tolerates junk", () => {
  const config = parseRepoConfig(`
ignore_paths:
  - dist
  - generated/
min_severity: High
not a real line
min_severity: Banana   # invalid severity is ignored, previous value stands
`);
  assert.deepEqual(config.ignorePaths, ["dist", "generated"]);
  assert.equal(config.minSeverity, "High");
});

test("empty and minimal configs are inert", () => {
  assert.deepEqual(parseRepoConfig(""), {});
  assert.deepEqual(parseRepoConfig("# only a comment\n"), {});
  assert.deepEqual(parseRepoConfig("skip: maybe"), {});
});

test("repoConfigDrops filters by path prefix and severity floor", () => {
  const config = parseRepoConfig("ignore_paths: [dist, gen]\nmin_severity: Medium");
  assert.equal(repoConfigDrops(config, { path: "dist/out.js", severity: "Critical" }), true);
  assert.equal(repoConfigDrops(config, { path: "gen/x.ts", severity: "Low" }), true);
  assert.equal(repoConfigDrops(config, { path: "distribution.js", severity: "High" }), false);
  assert.equal(repoConfigDrops(config, { path: "src/app.ts", severity: "Low" }), true);
  assert.equal(repoConfigDrops(config, { path: "src/app.ts", severity: "High" }), false);
  assert.equal(repoConfigDrops(null, { path: "anything", severity: "Low" }), false);
});
