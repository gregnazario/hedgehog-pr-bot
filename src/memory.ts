import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredIgnoreMemory {
  ignored: string[];
}

/**
 * Normalizes a comment or finding body into a matching key: severity
 * prefixes and model-label lines are stripped, whitespace collapsed,
 * lowercased, and capped. Two write-ups of the same issue from different
 * models or runs should land on the same fingerprint.
 */
export function findingFingerprint(input: { path?: unknown; body?: unknown }): string {
  const path = String(input.path ?? "");
  const body = String(input.body ?? "")
    .split("\n")
    .filter((line) => !/^_.*_$/.test(line.trim()))
    .join(" ")
    .replace(/\*\*(critical|high|medium|low):\*\*\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return `${path}\u0000${body}`;
}

export async function loadIgnoreMemory(path: string): Promise<Set<string>> {
  if (!path) return new Set();
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as StoredIgnoreMemory;
    return new Set(Array.isArray(parsed.ignored) ? parsed.ignored : []);
  } catch {
    return new Set();
  }
}

export async function appendIgnore(path: string, fingerprint: string): Promise<boolean> {
  if (!path) return false;
  const current = await loadIgnoreMemory(path);
  if (current.has(fingerprint)) return false;
  current.add(fingerprint);
  const payload: StoredIgnoreMemory = { ignored: [...current] };
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temporary, path);
  return true;
}
