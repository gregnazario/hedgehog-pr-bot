import assert from "node:assert/strict";
import test from "node:test";
import { errorMessage, withTimeout } from "../src/errors.ts";

test("errorMessage renders Errors and everything else", () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage({ weird: true }), "[object Object]");
});

test("withTimeout passes values through and rejects slow promises", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 1000, "job"), 42);
  await assert.rejects(withTimeout(new Promise(() => {}), 20, "Pi"), /Pi timed out after 20ms/);
  await assert.rejects(withTimeout(Promise.reject(new Error("early")), 1000, "Pi"), /early/);
});
