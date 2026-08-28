import assert from "node:assert/strict";
import test from "node:test";
import { loadReviewConfig, parseModelSpecs, reviewMarker } from "../src/config.ts";

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
