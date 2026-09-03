import { parseModelSpecs } from "./config.ts";
import type { ModelSpec, Severity } from "./types.ts";

const SEVERITIES = new Set(["Critical", "High", "Medium", "Low"]);

export interface RepoConfig {
  /** Silence hedgehog on this repository entirely. */
  skip?: boolean;
  /** Path prefixes; findings under them are never posted. */
  ignorePaths?: string[];
  /** Drop findings below this severity. */
  minSeverity?: Severity;
  /** Override the server's REVIEW_VERIFY setting for this repository. */
  verify?: boolean;
  /** Maintainer review guidance, included in the model prompt. */
  instructions?: string;
  /** Ask for a file-by-file walkthrough in the review body. */
  walkthrough?: boolean;
  /** Per-repository model list; changes the review fingerprint. */
  models?: ModelSpec[];
}

/**
 * Parses the flat `.hedgehog.yml` schema with a strict YAML subset: comments,
 * `key: value` scalars, inline `[a, b]` lists, `- item` block lists, and one
 * block scalar (`instructions: |`). Unknown keys are ignored so the schema
 * can grow; unparsable values fall back to defaults rather than failing the
 * review.
 */
export function parseRepoConfig(raw: string): RepoConfig {
  const config: RepoConfig = {};
  const lines = raw.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = normalize(lines[i] ?? "");
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Block scalar: instructions: | followed by indented lines.
    if (/^instructions:\s*\|$/.test(trimmed)) {
      const block = collectBlockScalar(lines, i + 1);
      if (block.text.trim()) config.instructions = block.text.trimEnd();
      i = block.lastIndex;
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();

    if (value === "" && normalize(lines[i + 1] ?? "").startsWith("- ")) {
      const items: string[] = [];
      while (normalize(lines[i + 1] ?? "").startsWith("- ")) {
        i += 1;
        items.push(stripQuotes(normalize(lines[i]).slice(2).trim()));
      }
      applyValue(config, key, items);
      continue;
    }

    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((entry) => stripQuotes(entry.trim()))
        .filter(Boolean);
      applyValue(config, key, items);
      continue;
    }

    if (value === "true" || value === "false") {
      applyValue(config, key, value === "true");
      continue;
    }

    applyValue(config, key, stripQuotes(value));
  }

  if (config.ignorePaths?.length === 0) delete config.ignorePaths;
  if (config.minSeverity !== undefined && !SEVERITIES.has(config.minSeverity)) {
    delete config.minSeverity;
  }
  return config;
}

interface BlockScalar {
  text: string;
  lastIndex: number;
}

/** Collects an indented block scalar, dedented by its first line's indent. */
function collectBlockScalar(lines: string[], start: number): BlockScalar {
  const body: string[] = [];
  let lastIndex = start - 1;
  let indent: number | null = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const leading = line.length - line.trimStart().length;
    if (indent === null) indent = leading;
    if (leading < (indent ?? 0)) break;
    body.push(line.slice(indent));
    lastIndex = i;
  }
  return { text: body.join("\n"), lastIndex };
}

function applyValue(config: RepoConfig, key: string, value: string[] | boolean | string): void {
  if (key === "skip" || key === "verify" || key === "walkthrough") {
    if (typeof value === "boolean") config[key] = value;
    return;
  }
  if (key === "instructions") {
    if (typeof value === "string" && value.trim()) config.instructions = value.trim();
    return;
  }
  if (key === "ignore_paths") {
    const list = Array.isArray(value) ? value : [String(value)];
    const paths = list.map((entry) => entry.replace(/\/+$/, "")).filter(Boolean);
    if (paths.length > 0) config.ignorePaths = paths;
    return;
  }
  if (key === "min_severity" && typeof value === "string" && SEVERITIES.has(value)) {
    config.minSeverity = value as Severity;
    return;
  }
  if (key === "models" && typeof value === "string" && value.trim()) {
    try {
      const models = parseModelSpecs(value);
      if (models.length > 0) config.models = models;
    } catch {
      // Invalid model specs are ignored; server defaults apply.
    }
  }
}

function normalize(line: string): string {
  return line.replaceAll("\t", "  ").trim();
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** True when the finding should be dropped by the repo's posting filters. */
export function repoConfigDrops(
  config: RepoConfig | null,
  finding: { path: string; severity: Severity },
): boolean {
  if (!config) return false;
  if (
    config.ignorePaths?.some(
      (prefix) => finding.path === prefix || finding.path.startsWith(`${prefix}/`),
    )
  ) {
    return true;
  }
  if (config.minSeverity) {
    const rank: Record<Severity, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
    if (rank[finding.severity] > rank[config.minSeverity]) return true;
  }
  return false;
}
