const MAX_SNAP_DISTANCE = 5;

export function parseDiffPath(raw) {
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

export function normalizePath(input) {
  let path = String(input ?? "").trim().replaceAll("\\", "/");
  if (path.startsWith("./")) path = path.slice(2);
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  while (path.startsWith("/")) path = path.slice(1);
  return path;
}

export function normalizeSide(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["left", "old", "-", "deletion", "deleted"].includes(text)) return "LEFT";
  if (["right", "new", "+", "addition", "added"].includes(text)) return "RIGHT";
  return null;
}

export function indexDiffLocations(diff) {
  const entries = [];
  const aliases = new Map();
  let oldPath = null;
  let newPath = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let hunkId = 0;

  const commentPath = () => (newPath && newPath !== "/dev/null" ? newPath : oldPath);

  const add = (side, line) => {
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
      oldPath = rawLine.slice("rename from ".length).trim();
      continue;
    }
    if (rawLine.startsWith("rename to ")) {
      newPath = rawLine.slice("rename to ".length).trim();
      if (oldPath && newPath && oldPath !== newPath) aliases.set(oldPath, newPath);
      continue;
    }
    if (rawLine.startsWith("--- ")) {
      oldPath = parseDiffPath(rawLine.slice(4));
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      newPath = parseDiffPath(rawLine.slice(4));
      if (oldPath && newPath && oldPath !== "/dev/null" && newPath !== "/dev/null" && oldPath !== newPath) {
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

  const byKey = new Map();
  for (const entry of entries) byKey.set(locationKey(entry.path, entry.side, entry.line), entry);
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
    resolvePath(input) {
      return resolveFilePath(input, paths, aliases);
    },
  };
}

export function annotateDiff(diff) {
  const output = [];
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
    if (rawLine.startsWith("diff --git ") || rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) {
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

export function resolveCommentAnchor(locations, finding) {
  const path = locations.resolvePath(finding.path);
  const line = Number(finding.line);
  if (!path || !Number.isSafeInteger(line) || line <= 0) return null;

  const requestedSide = normalizeSide(finding.side) || "RIGHT";
  const match = pickLocation(locations, path, requestedSide, line);
  if (!match) return null;

  const anchor = { path: match.path, line: match.line, side: match.side };
  const startLine = Number(finding.start_line ?? finding.startLine);
  if (Number.isSafeInteger(startLine) && startLine > 0 && startLine < match.line) {
    const start = locations.get(match.path, match.side, startLine);
    if (start && start.hunkId === match.hunkId) {
      anchor.start_line = startLine;
      anchor.start_side = match.side;
    }
  }
  return anchor;
}

function pickLocation(locations, path, side, line) {
  const exact = locations.get(path, side, line);
  if (exact) return exact;

  const other = side === "RIGHT" ? "LEFT" : "RIGHT";
  const nearestSame = nearestOnSide(locations, path, side, line);
  if (nearestSame && Math.abs(nearestSame.line - line) <= MAX_SNAP_DISTANCE) return nearestSame;

  const exactOther = locations.get(path, other, line);
  if (exactOther) return exactOther;

  const nearestOther = nearestOnSide(locations, path, other, line);
  if (nearestOther && Math.abs(nearestOther.line - line) <= MAX_SNAP_DISTANCE) return nearestOther;
  return null;
}

function nearestOnSide(locations, path, side, line) {
  let best = null;
  for (const entry of locations.entries) {
    if (entry.path !== path || entry.side !== side) continue;
    if (!best || closer(entry.line, best.line, line)) best = entry;
  }
  return best;
}

function closer(candidate, current, target) {
  const candidateDistance = Math.abs(candidate - target);
  const currentDistance = Math.abs(current - target);
  return candidateDistance < currentDistance || (candidateDistance === currentDistance && candidate < current);
}

function resolveFilePath(input, paths, aliases) {
  const path = normalizePath(input);
  if (!path) return "";
  if (paths.has(path)) return path;
  const aliased = aliases.get(path);
  if (aliased && paths.has(aliased)) return aliased;
  const matches = [...paths].filter((candidate) => candidate === path || candidate.endsWith(`/${path}`));
  return matches.length === 1 ? matches[0] : path;
}

function matchHunk(line) {
  const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!match) return null;
  return { oldStart: Number(match[1]), newStart: Number(match[2]) };
}

function splitDiff(diff) {
  return String(diff ?? "").split("\n");
}

function locationKey(path, side, line) {
  return `${path}\0${side}\0${line}`;
}

function unescapeGitPath(value) {
  return value
    .replaceAll("\\\\", "\\")
    .replaceAll("\\n", "\n")
    .replaceAll("\\t", "\t")
    .replaceAll('\\"', '"');
}
