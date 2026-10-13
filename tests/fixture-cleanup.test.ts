import assert from "node:assert/strict";
import test from "node:test";
import { cleanupThenSaveEvidence } from "./helpers/fixture-cleanup.ts";

test("fixture cleanup closes writers before evidence copy and preserves copy failure", async () => {
 const order: string[] = []; const failure = Object.assign(new Error("copy failed"), { code: "ENOENT" });
 await assert.rejects(cleanupThenSaveEvidence(async () => { order.push("closed"); }, async () => { order.push("copy"); throw failure; }), error => error === failure);
 assert.deepEqual(order, ["closed", "copy"]);
});
test("capture write failure cannot skip fixture cleanup", async () => {
 let closed = false; const failure = new Error("capture write failed");
 await assert.rejects(cleanupThenSaveEvidence(async () => { closed = true; }, async () => { assert.equal(closed, true); throw failure; }), error => error === failure);
 assert.equal(closed, true);
});
test("cleanup failure still saves evidence and both errors remain observable", async () => {
 const cleanup = new Error("cleanup failed"), copy = new Error("copy failed"); let saved = false;
 await assert.rejects(cleanupThenSaveEvidence(async () => { throw cleanup; }, async () => { saved = true; throw copy; }), error => error instanceof AggregateError && error.errors[0] === cleanup && error.errors[1] === copy);
 assert.equal(saved, true);
});
