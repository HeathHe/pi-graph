import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runV3Validation, runV3Validations } from "../src/v3/verify.ts";
import { validateValidationCommandV3 } from "../src/v3/validation-command.ts";

test("V3 verify runs a passing validation with exit code zero", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	const result = await runV3Validation("test -d .", cwd);
	assert.equal(result.ok, true);
	assert.equal(result.exitCode, 0);
	assert.equal(result.timedOut, false);
	assert.equal(result.signal, null);
});

test("V3 verify records a non-zero exit code as failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	const result = await runV3Validation("test -f missing-file.txt", cwd);
	assert.equal(result.ok, false);
	assert.notEqual(result.exitCode, 0);
});

test("V3 verify rejects shell operators, inline eval, and escapes", () => {
	assert.throws(() => validateValidationCommandV3("node -e '1'"), /Inline Node\.js evaluation/);
	assert.throws(() => validateValidationCommandV3("echo hi && touch x"), /Shell operator/);
	assert.throws(() => validateValidationCommandV3("npx cowsay hi"), /--no-install/);
	assert.throws(() => validateValidationCommandV3("git push origin main"), /not read-only/);
	assert.throws(() => validateValidationCommandV3("node ../escape.js"), /escapes/);
});

test("V3 verify caps per-stream output and flags truncation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	await writeFile(join(cwd, "noisy.js"), "for (let i = 0; i < 5000; i++) console.log('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');\n");
	// Use a tiny stream cap to force truncation with a whitelisted `node` invocation.
	const result = await runV3Validation("node noisy.js", cwd, { streamLimitBytes: 256 });
	assert.equal(result.stdoutTruncated, true);
	assert.ok(result.stdout.length <= 256);
	assert.equal(result.ok, true);
});

test("V3 verify applies stream caps to UTF-8 bytes rather than JavaScript characters", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	await writeFile(join(cwd, "unicode.js"), "process.stdout.write('界'.repeat(100));\n");
	const result = await runV3Validation("node unicode.js", cwd, { streamLimitBytes: 16 });
	assert.equal(result.stdoutTruncated, true);
	assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 16);
	assert.equal(result.ok, true);
});

test("V3 verify marks output beyond an exactly filled stream cap as truncated", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	await writeFile(join(cwd, "exact.js"), "process.stdout.write('12345678'); setImmediate(() => process.stdout.write('9'));\n");
	const result = await runV3Validation("node exact.js", cwd, { streamLimitBytes: 8 });
	assert.equal(result.stdout, "12345678");
	assert.equal(result.stdoutTruncated, true);
});

test("V3 verify has no default execution deadline and records explicit cancellation", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	await writeFile(join(cwd, "slow.js"), "setTimeout(() => {}, 60000);\n");
	const started = Date.now();
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 300);
	const result = await runV3Validation("node slow.js", cwd, { signal: stop.signal });
	assert.equal(result.timedOut, false);
	assert.equal(result.ok, false);
	assert.ok(Date.now() - started < 3_000);
});

test("V3 verify records the terminating signal when a child is killed", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	await writeFile(join(cwd, "slow.js"), "setTimeout(() => {}, 60000);\n");
	const stop = new AbortController();
	setTimeout(() => stop.abort(), 200);
	const result = await runV3Validation("node slow.js", cwd, { signal: stop.signal });
	assert.equal(result.timedOut, false);
	assert.ok(result.signal);
	assert.equal(result.ok, false);
});

test("V3 verify stops on the first failing validation command", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "v3-verify-"));
	const results = await runV3Validations(["test -f nope.txt", "test -d ."], cwd);
	assert.equal(results.length, 1);
	assert.equal(results[0]!.ok, false);
});
