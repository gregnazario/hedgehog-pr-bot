import type { Side } from "./types.ts";

const MAX_SNAP_DISTANCE = 5;

export interface DiffLocation {
  path: string;
  side: Side;
  line: number;
  hunkId: number;
}

export interface DiffLocations {
  readonly entries: readonly DiffLocation[];
  readonly aliases: ReadonlyMap<string, string>;
  has(path: string, side: Side, line: number): boolean;
  get(path: string, side: Side, line: number): DiffLocation | undefined;
  nearest(path: string, side: Side, line: number): DiffLocation | undefined;
  resolvePath(input: unknown): string;
}

export interface CommentAnchorInput {
  path?: unknown;
  line?: unknown;
  side?: unknown;
  start_line?: unknown;
}

export function parseDiffPath(raw: unknown): string {
  let value = String(raw ?? "").trim();
  if (value.startsWith('"')) {
    const end = value.indexOf('"', 1);
    if (end > 0) {
      value = unescapeGitPath(value.slice(1, end));
    }
  } else {
    const tab = value.indexOf("\t");
    if (tab >= 0) value = value.slice(0, tab);
  }
  if (value === "/dev/null") return "/dev/null";
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

export function normalizePath(input: unknown): string {
  let path = String(input ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

export function normalizeSide(value: unknown): Side | null {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (["left", "old", "-", "deletion", "deleted"].includes(text)) return "LEFT";
  if (["right", "new", "+", "addition", "added"].includes(text)) return "RIGHT";
  return null;
}

export function indexDiffLocations(diff: unknown): DiffLocations {
  const entries: DiffLocation[] = [];
  const aliases = new Map<string, string>();
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunkId = 0;

  const commentPath = () => (newPath && newPath !== "/dev/null" ? newPath : oldPath);

  const add = (side: Side, line: number) => {
    const path = commentPath();
    if (!path || path === "/dev/null" || line < 1) return;
    entries.push({ path, side, line, hunkId });
  };

  for (const rawLine of splitDiff(diff)) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      oldPath = null;
      newPath = null;
      continue;
    }
    if (rawLine.startsWith("rename from ")) {
      oldPath = parseDiffPath(rawLine.slice("rename from ".length));
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      newPath = parseDiffPath(rawLine.slice("rename to ".length));
      if (oldPath && newPath && oldPath !== newPath) aliases.set(oldPath, newPath);
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      oldPath = parseDiffPath(rawLine.slice(4));
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      newPath = parseDiffPath(rawLine.slice(4));
      if (
        oldPath &&
        newPath &&
        oldPath !== "/dev/null" &&
        newPath !== "/dev/null" &&
        oldPath !== newPath
      ) {
        aliases.set(oldPath, newPath);
      }
      continue;
    }

    const hunk = matchHunk(rawLine);
    if (hunk) {
      inHunk = true;
      hunkId += 1;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!inHunk) continue;

    if (rawLine.startsWith("\\") || rawLine === "") continue;
    if (rawLine.startsWith("+")) {
      add("RIGHT", newLine);
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      add("LEFT", oldLine);
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      add("LEFT", oldLine);
      add("RIGHT", newLine);
      oldLine += 1;
      newLine += 1;
    } else {
      inHunk = false;
    }
  }

  const byKey = new Map<string, DiffLocation>();
  const bySide = new Map<string, DiffLocation[]>();
  for (const entry of entries) {
    byKey.set(locationKey(entry.path, entry.side, entry.line), entry);
    const bucketKey = sideKey(entry.path, entry.side);
    const bucket = bySide.get(bucketKey);
    if (bucket) bucket.push(entry);
    else bySide.set(bucketKey, [entry]);
  }
  const paths = new Set(entries.map((entry) => entry.path));

  return {
    entries,
    aliases,
    has(path, side, line) {
      return byKey.has(locationKey(path, side, line));
    },
    get(path, side, line) {
      return byKey.get(locationKey(path, side, line));
    },
    nearest(path, side, line) {
      return nearestInBucket(bySide.get(sideKey(path, side)) ?? [], line);
    },
    resolvePath(input) {
      return resolveFilePath(input, paths, aliases);
    },
  };
}

export interface PullRequestFile {
  filename: string;
  previous_filename?: string;
  status?: string;
  patch?: string | null;
}

/** Rebuilds a unified diff from "list pull request files" entries so the
 * diff parser works on PRs GitHub refuses to serve as one document. */
export function diffFromPullRequestFiles(files: readonly PullRequestFile[]): string {
  const chunks: string[] = [];
  for (const file of files) {
    const oldPath = file.previous_filename ?? file.filename;
    const lines = [`diff --git a/${oldPath} b/${file.filename}`];
    if (file.status === "renamed" && file.previous_filename) {
      lines.push(`rename from ${file.previous_filename}`, `rename to ${file.filename}`);
    }
    lines.push(
      `--- ${file.status === "added" ? "/dev/null" : `a/${oldPath}`}`,
      `+++ ${file.status === "removed" ? "/dev/null" : `b/${file.filename}`}`,
    );
    if (file.patch) lines.push(file.patch);
    chunks.push(lines.join("\n"));
  }
  return chunks.join("\n");
}

export function annotateDiff(diff: unknown): string {
  const output: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const rawLine of splitDiff(diff)) {
    const hunk = matchHunk(rawLine);
    if (hunk) {
      inHunk = true;
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      output.push(rawLine);
      continue;
    }
    if (
      rawLine.startsWith("diff --git ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      inHunk = false;
      output.push(rawLine);
      continue;
    }
    if (!inHunk || rawLine.startsWith("\\") || rawLine === "") {
      output.push(rawLine);
      continue;
    }
    if (rawLine.startsWith("+")) {
      output.push(`[RIGHT ${newLine}] ${rawLine}`);
      newLine += 1;
    } else if (rawLine.startsWith("-")) {
      output.push(`[LEFT ${oldLine}] ${rawLine}`);
      oldLine += 1;
    } else if (rawLine.startsWith(" ")) {
      output.push(`[RIGHT ${newLine}] ${rawLine}`);
      oldLine += 1;
      newLine += 1;
    } else {
      inHunk = false;
      output.push(rawLine);
    }
  }
  return output.join("\n");
}

export interface CommentAnchor {
  path: string;
  line: number;
  side: Side;
}

export function resolveCommentAnchor(
  locations: DiffLocations,
  finding: CommentAnchorInput,
): CommentAnchor | null {
  const path = locations.resolvePath(finding.path);
  const line = Number(finding.line);
  if (!path || !Number.isSafeInteger(line) || line <= 0) return null;

  const requestedSide = normalizeSide(finding.side) || "RIGHT";
  const match = pickLocation(locations, path, requestedSide, line);
  if (!match) return null;
  return { path: match.path, line: match.line, side: match.side };
}

function pickLocation(
  locations: DiffLocations,
  path: string,
  side: Side,
  line: number,
): DiffLocation | undefined {
  const exact = locations.get(path, side, line);
  if (exact) return exact;

  const other = side === "RIGHT" ? "LEFT" : "RIGHT";
  const exactOther = locations.get(path, other, line);
  if (exactOther) return exactOther;

  const nearestSame = locations.nearest(path, side, line);
  if (nearestSame && Math.abs(nearestSame.line - line) <= MAX_SNAP_DISTANCE) return nearestSame;
  return undefined;
}

// Buckets hold locations for one path and side in ascending line order, so the
// nearest line is found with a binary search instead of scanning the diff.
function nearestInBucket(bucket: readonly DiffLocation[], line: number): DiffLocation | undefined {
  let low = 0;
  let high = bucket.length - 1;
  if (high < 0) return undefined;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (bucket[mid].line < line) low = mid + 1;
    else high = mid;
  }
  const after = bucket[low];
  const before = low > 0 ? bucket[low - 1] : undefined;
  if (!before) return after;
  if (after.line - line < line - before.line) return after;
  return before;
}

function resolveFilePath(
  input: unknown,
  paths: ReadonlySet<string>,
  aliases: ReadonlyMap<string, string>,
): string {
  const path = normalizePath(input);
  if (!path) return "";
  if (paths.has(path)) return path;
  const aliased = aliases.get(path);
  if (aliased && paths.has(aliased)) return aliased;
  const matches = [...paths].filter(
    (candidate) => candidate === path || candidate.endsWith(`/${path}`),
  );
  return matches.length === 1 ? matches[0] : path;
}

function matchHunk(line: string): { oldStart: number; newStart: number } | null {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function splitDiff(diff: unknown): string[] {
  return String(diff ?? "").split("\n");
}

function locationKey(path: string, side: Side, line: number): string {
  return `${path}\0${side}\0${line}`;
}

function sideKey(path: string, side: Side): string {
  return `${path}\0${side}`;
}

function unescapeGitPath(value: string): string {
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"');
}
