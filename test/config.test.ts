import assert from "node:assert/strict";
import test from "node:test";
import {
  loadReviewConfig,
  parseModelSpecs,
  repoModelsFingerprint,
  reviewMarker,
} from "../src/config.ts";

test("parses multiple Pi model specifications", () => {
  assert.deepEqual(parseModelSpecs("zai/glm-5.3:high,openai/gpt-5:medium"), [
    { provider: "zai", model: "glm-5.3", thinking: "high", label: "zai/glm-5.3:high" },
    { provider: "openai", model: "gpt-5", thinking: "medium", label: "openai/gpt-5:medium" },
  ]);
});

test("review fingerprint changes with the model configuration", () => {
  const first = loadReviewConfig({ PI_MODELS: "zai/glm-5.3:high" });
  const second = loadReviewConfig({ PI_MODELS: "zai/glm-5.3:medium" });
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("review marker encodes head SHA and config fingerprint", () => {
  assert.equal(reviewMarker("abc", "fp12"), "<!-- greg-pr-bot-review head:abc config:fp12 -->");
});

test("review config reads the bot login with a hedgehog default", () => {
  assert.equal(loadReviewConfig({}).botLogin, "hedgehog-pr-bot");
  assert.equal(loadReviewConfig({ BOT_LOGIN: "MyReviewer[Bot]" }).botLogin, "myreviewer");
});

test("parses quality knobs: large models, file budget, verification", () => {
  const base = loadReviewConfig({});
  assert.equal(base.largeModels?.length ?? 0, 0);
  assert.equal(base.fileContextBytes, 64 * 1024);
  assert.equal(base.verifyFindings, true);
  assert.equal(loadReviewConfig({ REVIEW_VERIFY: "false" }).verifyFindings, false);

  const withLarge = loadReviewConfig({
    PI_MODELS: "zai/glm-5.3:high",
    PI_MODELS_LARGE: "zai/glm-4.7:low",
  });
  assert.deepEqual(
    withLarge.largeModels?.map((spec) => spec.label),
    ["zai/glm-4.7:low"],
  );
  assert.notEqual(withLarge.fingerprint, base.fingerprint);
});

test("repoModelsFingerprint folds per-repo models, keeps base otherwise", () => {
  const base = "abc123base";
  assert.equal(repoModelsFingerprint(base, []), base);
  const models = [{ provider: "zai", model: "glm-4.7", thinking: "low", label: "zai/glm-4.7:low" }];
  assert.notEqual(repoModelsFingerprint(base, models), base);
  assert.equal(repoModelsFingerprint(base, models), repoModelsFingerprint(base, models));
});
