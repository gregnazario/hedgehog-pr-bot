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

test("parses instructions block scalars, walkthrough, and models", () => {
  const config = parseRepoConfig(`
instructions: |
  We use React 19 server components.
  Flag any client-only hooks.
walkthrough: true
models: zai/glm-4.7:low, openai/gpt-5:medium
`);
  assert.equal(
    config.instructions,
    "We use React 19 server components.\nFlag any client-only hooks.",
  );
  assert.equal(config.walkthrough, true);
  assert.deepEqual(
    config.models?.map((spec) => spec.label),
    ["zai/glm-4.7:low", "openai/gpt-5:medium"],
  );
});

test("invalid models and single-line instructions degrade gracefully", () => {
  const config = parseRepoConfig(`
models: not-a-model-spec
instructions: "One line of guidance"
walkthrough: maybe
`);
  assert.equal(config.models, undefined);
  assert.equal(config.instructions, "One line of guidance");
  assert.equal(config.walkthrough, undefined);
});

test("focus accepts taxonomy names and drops everything else", () => {
  const config = parseRepoConfig(`
focus: [Security, correctness, vibes]
`);
  assert.deepEqual(config.focus, ["security", "correctness"]);

  assert.deepEqual(parseRepoConfig("focus: performance").focus, ["performance"]);
  assert.deepEqual(parseRepoConfig("focus:\n  - tests\n  - accessibility").focus, [
    "tests",
    "accessibility",
  ]);
  assert.equal(parseRepoConfig("focus: [vibes, style]").focus, undefined);
});
