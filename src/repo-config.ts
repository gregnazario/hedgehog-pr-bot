import type { Severity } from "./types.ts";

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
}

/**
 * Parses the flat `.hedgehog.yml` schema with a strict YAML subset: comments,
 * `key: value` scalars, inline `[a, b]` lists, and `- item` block lists.
 * Unknown keys are ignored so the schema can grow; unparsable values fall
 * back to defaults rather than failing the review.
 */
export function parseRepoConfig(raw: string): RepoConfig {
  const config: RepoConfig = {};
  const lines = raw
    .split("\n")
    .map((line) => line.replace(/\t/g, "  "))
    .map((line) => line.trim());

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();

    // Block list: collect following "- item" lines.
    if (value === "" && lines[i + 1]?.startsWith("- ")) {
      const items: string[] = [];
      while (lines[i + 1]?.startsWith("- ")) {
        i += 1;
        items.push(stripQuotes(lines[i].slice(2).trim()));
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

function applyValue(config: RepoConfig, key: string, value: string[] | boolean | string): void {
  if (key === "skip" || key === "verify") {
    if (typeof value === "boolean") config[key] = value;
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
  }
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
