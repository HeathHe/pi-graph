import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseCommand, runValidation } from "../src/validation.ts";

test("validation parser preserves quoted arguments without invoking a shell", () => {
	assert.deepEqual(parseCommand("node --test 'tests/a b.test.js'"), ["node", "--test", "tests/a b.test.js"]);
	assert.throws(() => parseCommand("npm test && rm -rf /"), /Shell operator/);
});

test("validation rejects unapproved executables and executes approved commands", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-validation-"));
	await writeFile(join(cwd, "ok.txt"), "ok");
	assert.equal((await runValidation("test -f ok.txt", cwd, 1_000)).ok, true);
	const rejected = await runValidation("sh -c 'exit 0'", cwd, 1_000);
	assert.equal(rejected.ok, false);
	assert.match(rejected.stderr, /not allowed/);
});

test("validation rejects interpreter payloads, downloads, cwd escapes, and mutating git", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-validation-"));
	for (const command of [
		"node -e 'process.exit(0)'",
		"python3 -c 'print(1)'",
		"npx tsc --noEmit",
		"git commit -m test",
		"test -f /etc/passwd",
		"test -f ../outside",
	]) {
		const result = await runValidation(command, cwd, 1_000);
		assert.equal(result.ok, false, command);
	}
});

test("validation abort terminates a running process", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-validation-abort-"));
	await writeFile(join(cwd, "wait.mjs"), "setTimeout(() => {}, 10_000);\n");
	const controller = new AbortController();
	const running = runValidation("node wait.mjs", cwd, 20_000, controller.signal);
	setTimeout(() => controller.abort("stop"), 30);
	const result = await running;
	assert.equal(result.ok, false);
	assert.equal(result.aborted, true);
	assert.ok(result.durationMs < 2_000);
});
