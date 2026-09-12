// Authoring-time tool: turns each case's before/ after/ trees into a
// diff.patch plus a truth.json with anchors resolved to line numbers.
//   node benchmarks/gen.ts
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const casesRoot = new URL("./cases/", import.meta.url).pathname;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const resolveAnchor = (afterRoot: string, path: string, anchor: string): number => {
  const lines = readFileSync(join(afterRoot, path), "utf8").split("\n");
  const index = lines.findIndex((line) => line.includes(anchor));
  if (index < 0) throw new Error(`anchor not found in ${path}: ${anchor}`);
  return index + 1;
};

const diffFile = (caseDir: string, path: string): string => {
  // Run from the case directory so headers carry before/<path> and
  // after/<path>, which we rewrite to the git-style a/<path> b/<path>.
  // --no-index also handles added/deleted files natively; exit 1 = differ.
  const result = spawnSync(
    "git",
    ["diff", "--no-index", "--src-prefix=a/", "--dst-prefix=b/", `before/${path}`, `after/${path}`],
    { cwd: caseDir, encoding: "utf8" },
  );
  if (result.status !== 1 || !result.stdout) throw new Error(`diff failed for ${path}`);
  return result.stdout.replaceAll("a/before/", "a/").replaceAll("b/after/", "b/");
};

for (const entry of readdirSync(casesRoot).sort()) {
  const caseDir = join(casesRoot, entry);
  if (!statSync(caseDir).isDirectory()) continue;
  const meta = JSON.parse(readFileSync(join(caseDir, "meta.json"), "utf8")) as {
    title: string;
    clean: boolean;
    truth: Array<{ path: string; anchor: string; class: string; note: string }>;
  };
  const beforeRoot = join(caseDir, "before");
  const afterRoot = join(caseDir, "after");
  const beforeFiles = walk(beforeRoot).map((full) => full.slice(beforeRoot.length + 1));
  const afterFiles = walk(afterRoot).map((full) => full.slice(afterRoot.length + 1));
  const changed = [...new Set([...beforeFiles, ...afterFiles])].filter(
    (path) =>
      readFileSync(join(beforeRoot, path), "utf8") !== readFileSync(join(afterRoot, path), "utf8"),
  );
  if (changed.length === 0) throw new Error(`${entry}: no changed files`);

  writeFileSync(
    join(caseDir, "diff.patch"),
    changed.map((path) => diffFile(caseDir, path)).join("\n"),
  );
  writeFileSync(
    join(caseDir, "case.json"),
    `${JSON.stringify(
      {
        name: entry,
        title: meta.title,
        clean: meta.clean,
        truth: meta.truth.map((item) => ({
          ...item,
          line: resolveAnchor(afterRoot, item.path, item.anchor),
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${entry}: ${changed.length} file(s), ${meta.truth.length} planted bug(s)`);
}
