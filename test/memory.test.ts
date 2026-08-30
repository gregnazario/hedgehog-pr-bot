import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendIgnore, findingFingerprint, loadIgnoreMemory } from "../src/memory.ts";

test("fingerprints ignore severity prefixes, model labels, and formatting", () => {
  const formatted = findingFingerprint({
    path: "src/app.mjs",
    body: "_zai/glm-5.3:high_\n\n**High:** The  cache   is never cleared.",
  });
  const plain = findingFingerprint({
    path: "src/app.mjs",
    body: "the cache is never cleared.",
  });
  assert.equal(formatted, plain);
  assert.notEqual(
    formatted,
    findingFingerprint({ path: "src/other.mjs", body: "the cache is never cleared." }),
  );
  assert.notEqual(
    formatted,
    findingFingerprint({ path: "src/app.mjs", body: "a different issue entirely" }),
  );
});

test("ignore memory round-trips and dedupes across restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hedgehog-memory-"));
  const path = join(dir, "ignores.json");
  const first = findingFingerprint({ path: "a.mjs", body: "issue one" });
  const second = findingFingerprint({ path: "b.mjs", body: "issue two" });

  assert.equal(await appendIgnore(path, first), true);
  assert.equal(await appendIgnore(path, first), false);
  assert.equal(await appendIgnore(path, second), true);

  const loaded = await loadIgnoreMemory(path);
  assert.equal(loaded.size, 2);
  assert.equal(loaded.has(first), true);

  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.ignored.length, 2);
});

test("empty or corrupt memory files load as empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hedgehog-memory-"));
  assert.equal((await loadIgnoreMemory("")).size, 0);
  const corrupt = join(dir, "corrupt.json");
  await writeFile(corrupt, "{not json", "utf8");
  assert.equal((await loadIgnoreMemory(corrupt)).size, 0);
});
