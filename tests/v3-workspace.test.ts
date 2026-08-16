import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { readV3WorkspaceEvidence } from "../src/v3/attempt.ts";
import { prepareV3Workspace, reopenV3Workspace, V3WorkspaceConflictError } from "../src/v3/workspace.ts";
import type { CompiledGraphNodeV3 } from "../src/v3/types.ts";

async function workspaceFixture() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-ws-")));
	const sourceCwd = join(sandbox, "source");
	await mkdir(sourceCwd, { recursive: true });
	const runDir = join(sandbox, "run");
	await mkdir(runDir, { recursive: true });
	return { sandbox, sourceCwd, runDir };
}

function node(taskId: string, extra: Partial<CompiledGraphNodeV3> = {}): CompiledGraphNodeV3 {
	const base: CompiledGraphNodeV3 = {
		taskId,
		agent: "test-agent",
		task: `task ${taskId}`,
		dependsOn: [],
		inputArtifacts: [],
		outputArtifact: `g/${taskId}/out`,
		readScope: [],
		writeScope: [],
		sideEffect: "local_write",
		retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 },
		validationCommands: [],
	};
	return { ...base, ...extra };
}

test("V3 workspace captures baselines, inspects writes, and applies within scope", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	await writeFile(join(sourceCwd, "target.txt"), "before\n", "utf8");
	const graphNode = node("w1", { writeScope: [{ kind: "file", path: "target.txt" }], validationCommands: ["test -f target.txt"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	assert.equal(prepared.kind, "shadow");
	const baseline = prepared.evidence.writeBaseline[resolve(sourceCwd, "target.txt")];
	assert.match(baseline ?? "", /^[a-f0-9]{64}$/);
	// Child edits the workspace file.
	await writeFile(join(prepared.workspaceCwd, "target.txt"), "after\n", "utf8");
	const writes = await prepared.inspectWrites();
	assert.equal(writes.length, 1);
	assert.equal(writes[0]!.path, resolve(sourceCwd, "target.txt"));
	// Apply propagates to source.
	const applied = await prepared.apply();
	assert.equal(applied.length, 1);
	assert.equal(await readFile(join(sourceCwd, "target.txt"), "utf8"), "after\n");
	await prepared.cleanup();
});

test("V3 workspace applies a newly created file and records it as a write", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	const graphNode = node("w2", { writeScope: [{ kind: "file", path: "created.txt" }], validationCommands: ["test -f created.txt"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	await writeFile(join(prepared.workspaceCwd, "created.txt"), "new\n", "utf8");
	const applied = await prepared.apply();
	assert.equal(applied.length, 1);
	assert.ok(!applied[0]!.before);
	assert.ok(applied[0]!.after);
	assert.equal(await readFile(join(sourceCwd, "created.txt"), "utf8"), "new\n");
	await prepared.cleanup();
});

test("V3 workspace rejects a concurrent source edit as a conflict and never overwrites it", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	await writeFile(join(sourceCwd, "target.txt"), "before\n", "utf8");
	const graphNode = node("w3", { writeScope: [{ kind: "file", path: "target.txt" }], validationCommands: ["test -f target.txt"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	await writeFile(join(prepared.workspaceCwd, "target.txt"), "child\n", "utf8");
	// Concurrent source edit between baseline and apply.
	await writeFile(join(sourceCwd, "target.txt"), "concurrent\n", "utf8");
	await assert.rejects(() => prepared.apply(), V3WorkspaceConflictError);
	assert.equal(await readFile(join(sourceCwd, "target.txt"), "utf8"), "concurrent\n");
	await prepared.cleanup();
});

test("V3 workspace can be reopened from evidence for crash recovery", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	await writeFile(join(sourceCwd, "target.txt"), "before\n", "utf8");
	const graphNode = node("w4", { writeScope: [{ kind: "file", path: "target.txt" }], validationCommands: ["test -f target.txt"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	const evidence = await readV3WorkspaceEvidence(runDir, "w4", 1);
	assert.ok(evidence);
	await writeFile(join(prepared.workspaceCwd, "target.txt"), "after\n", "utf8");
	// Simulate a crash: reopen from evidence instead of the live object.
	const reopened = await reopenV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspaceCwd: evidence.workspaceDir, kind: "shadow" });
	const applied = await reopened.apply();
	assert.equal(applied.length, 1);
	assert.equal(await readFile(join(sourceCwd, "target.txt"), "utf8"), "after\n");
	await reopened.cleanup();
});

test("V3 workspace apply is idempotent across crash recovery", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	await writeFile(join(sourceCwd, "target.txt"), "before\n", "utf8");
	const graphNode = node("w5", { writeScope: [{ kind: "file", path: "target.txt" }], validationCommands: ["test -f target.txt"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	await writeFile(join(prepared.workspaceCwd, "target.txt"), "after\n", "utf8");
	const first = await prepared.apply();
	assert.equal(first.length, 1);
	// A second apply is safe (no conflict, no double-write corruption); it reports the already-applied write.
	const second = await prepared.apply();
	assert.equal(second.length, 1);
	assert.equal(second[0]!.path, resolve(sourceCwd, "target.txt"));
	assert.equal(await readFile(join(sourceCwd, "target.txt"), "utf8"), "after\n");
	await prepared.cleanup();
});

test("V3 compile rejects overlapping write scopes without a dependency (scheduler precondition)", () => {
	const spec = {
		schemaVersion: 3,
		goal: "overlap",
		nodes: [
			{ taskId: "a", agent: "x", task: "a", sideEffect: "local_write", writeScope: [{ kind: "file", path: "same.txt" }], validationCommands: ["test -f same.txt"] },
			{ taskId: "b", agent: "x", task: "b", sideEffect: "local_write", writeScope: [{ kind: "file", path: "same.txt" }], validationCommands: ["test -f same.txt"] },
		],
	};
	assert.throws(() => compileGraphSpecV3(spec));
});
