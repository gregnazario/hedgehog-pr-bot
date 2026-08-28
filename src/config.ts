import { createHash } from "node:crypto";
import { DEFAULT_BOT_LOGIN, normalizeBotLogin } from "./signals.ts";
import type { EnvSource, ModelSpec, ReviewConfig } from "./types.ts";

export const markerPrefix = "<!-- greg-pr-bot-review ";

export function reviewMarker(headSha: string, fingerprint: string): string {
  return `${markerPrefix}head:${headSha} config:${fingerprint} -->`;
}

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseModelSpecs(value: string): ModelSpec[] {
  const thinkingLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) throw new Error("PI_MODELS must contain at least one model");

  return entries.map((entry) => {
    let providerAndModel = entry;
    let thinking = "high";
    const colon = entry.lastIndexOf(":");
    if (colon > 0 && thinkingLevels.has(entry.slice(colon + 1))) {
      providerAndModel = entry.slice(0, colon);
      thinking = entry.slice(colon + 1);
    }

    const slash = providerAndModel.indexOf("/");
    if (slash <= 0 || slash === providerAndModel.length - 1) {
      throw new Error(`Invalid PI_MODELS entry "${entry}"; expected provider/model[:thinking]`);
    }

    const provider = providerAndModel.slice(0, slash);
    const model = providerAndModel.slice(slash + 1);
    return { provider, model, thinking, label: `${provider}/${model}:${thinking}` };
  });
}

export function loadReviewConfig(env: EnvSource = process.env): ReviewConfig {
  const models = parseModelSpecs(env.PI_MODELS || "zai/glm-5.3:high");
  return {
    author: (env.PR_AUTHOR || "gregnazario").toLowerCase(),
    botLogin: normalizeBotLogin(env.BOT_LOGIN || DEFAULT_BOT_LOGIN),
    maxDiffChars: positiveInteger(env.MAX_DIFF_CHARS, 4_000_000),
    models,
    fingerprint: createHash("sha256")
      .update(models.map((spec) => spec.label).join(","))
      .digest("hex")
      .slice(0, 12),
  };
}

export function loadPrivateKey(env: EnvSource): string {
  if (env.APP_PRIVATE_KEY_BASE64) {
    return Buffer.from(env.APP_PRIVATE_KEY_BASE64, "base64").toString("utf8");
  }
  if (env.APP_PRIVATE_KEY) return env.APP_PRIVATE_KEY.replaceAll("\\n", "\n");
  throw new Error("APP_PRIVATE_KEY or APP_PRIVATE_KEY_BASE64 is required");
}
