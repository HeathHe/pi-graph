import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { readV3WorkspaceEvidence, v3NodeAttemptDir } from "../src/v3/attempt.ts";
import {
	digestFile,
	freezeV3GraphAgents,
	prepareV3Workspace,
	removeV3OrphanAgentProfiles,
	removeV3UncommittedAgentProfiles,
	reopenV3Workspace,
	V3WorkspaceConflictError,
} from "../src/v3/workspace.ts";
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

test("V3 tree write scopes detect and atomically apply newly-created nested files", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	await mkdir(join(sourceCwd, "docs"));
	const graphNode = node("tree-write", { writeScope: [{ kind: "tree", path: "docs" }], validationCommands: ["test -f docs/new/nested.md"] });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	await mkdir(join(prepared.workspaceCwd, "docs", "new"), { recursive: true });
	await writeFile(join(prepared.workspaceCwd, "docs", "new", "nested.md"), "new tree file\n", "utf8");
	const inspected = await prepared.inspectWrites();
	assert.deepEqual(inspected.map((entry) => entry.path), [join(sourceCwd, "docs", "new", "nested.md")]);
	const applied = await prepared.apply();
	assert.deepEqual(applied.map((entry) => entry.path), [join(sourceCwd, "docs", "new", "nested.md")]);
	assert.equal(await readFile(join(sourceCwd, "docs", "new", "nested.md"), "utf8"), "new tree file\n");
	await prepared.cleanup();
});

test("V3 workspace materializes a frozen project-only Agent with Graph Guard and a bounded contract", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	await mkdir(join(sourceCwd, ".pi", "agents"), { recursive: true });
	await writeFile(join(sourceCwd, ".pi", "agents", "frozen.md"), [
		"---",
		"name: frozen",
		"description: Frozen V3 test Agent",
		"---",
		"",
		"Original frozen instructions.",
		"",
	].join("\n"), "utf8");
	const graphNode = node("frozen-node", { agent: "frozen", sideEffect: "none" });
	await freezeV3GraphAgents(runDir, sourceCwd, [graphNode]);
	await writeFile(join(sourceCwd, ".pi", "agents", "frozen.md"), "---\nname: frozen\ndescription: changed\n---\n\nChanged later.\n", "utf8");
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	const materialized = await readFile(join(prepared.workspaceCwd, ".pi", "agents", "frozen.md"), "utf8");
	assert.match(materialized, /Original frozen instructions/);
	assert.doesNotMatch(materialized, /Changed later/);
	assert.match(materialized, /pi-graph-guard\.ts/);
	const contract = JSON.parse(await readFile(join(prepared.workspaceCwd, ".pi-graph", "node-contract.json"), "utf8")) as Record<string, unknown>;
	assert.equal(contract.workspaceCwd, prepared.workspaceCwd);
	assert.equal(contract.allowBash, false);
	assert.deepEqual(contract.readScope, []);
	assert.deepEqual(contract.writeScope, []);
	await prepared.cleanup();
});

test("V3 Agent freeze rejects definitions available only from user scope", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	const userAgents = join(sandbox, "user-agents");
	await mkdir(userAgents, { recursive: true });
	await writeFile(join(userAgents, "user-only-v3-agent.md"), [
		"---",
		"name: user-only-v3-agent",
		"description: Must not cross the project-only V3 boundary",
		"---",
		"",
		"User-scoped instructions.",
		"",
	].join("\n"), "utf8");
	const prior = process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
	process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = userAgents;
	try {
		await assert.rejects(
			freezeV3GraphAgents(runDir, sourceCwd, [node("user-scope", { agent: "user-only-v3-agent", sideEffect: "none" })]),
			/Agent 'user-only-v3-agent' is not available/u,
		);
	} finally {
		if (prior === undefined) delete process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS;
		else process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS = prior;
	}
});

test("V3 append profile cleanup removes only the unpublished inode and permits a later legal definition", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	await mkdir(join(sourceCwd, ".pi", "agents"), { recursive: true });
	await writeFile(join(sourceCwd, ".pi", "agents", "first.md"), "---\nname: first\ndescription: First\n---\n\nFirst profile.\n", "utf8");
	await writeFile(join(sourceCwd, ".pi", "agents", "second.md"), "---\nname: second\ndescription: Second\n---\n\nSecond profile.\n", "utf8");
	const first = node("late-node", { agent: "first", sideEffect: "none" });
	const publication = await freezeV3GraphAgents(runDir, sourceCwd, [first]);
	assert.equal(publication.length, 1);
	assert.deepEqual(await removeV3UncommittedAgentProfiles(runDir, publication), ["late-node"]);
	await assert.rejects(readFile(join(runDir, "agent-profiles", "late-node.json"), "utf8"), { code: "ENOENT" });

	// Model SIGKILL after freeze but before the append revision: there is no
	// in-memory publication token on recovery, so the lease holder clears the
	// graph-absent orphan before freezing the replacement definition.
	await freezeV3GraphAgents(runDir, sourceCwd, [first]);
	assert.deepEqual(await removeV3OrphanAgentProfiles(runDir, [first]), ["late-node"]);
	const second = node("late-node", { agent: "second", sideEffect: "none" });
	assert.equal((await freezeV3GraphAgents(runDir, sourceCwd, [second])).length, 1);
	assert.match(await readFile(join(runDir, "agent-profiles", "late-node.json"), "utf8"), /Second profile/u);
});

test("V3 append rollback never unlinks a replacement profile with a different inode", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	await mkdir(join(sourceCwd, ".pi", "agents"), { recursive: true });
	await writeFile(join(sourceCwd, ".pi", "agents", "first.md"), "---\nname: first\ndescription: First\n---\n\nFirst profile.\n", "utf8");
	const graphNode = node("profile-race", { agent: "first", sideEffect: "none" });
	const [publication] = await freezeV3GraphAgents(runDir, sourceCwd, [graphNode]);
	assert.ok(publication);
	const path = join(runDir, "agent-profiles", "profile-race.json");
	const moved = `${path}.old`;
	await rename(path, moved);
	await writeFile(path, await readFile(moved));
	await assert.rejects(removeV3UncommittedAgentProfiles(runDir, [publication]), /changed identity/u);
	assert.match(await readFile(path, "utf8"), /First profile/u, "the replacement inode must remain present");
});

test("V3 recovery rejects a modified workspace contract", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	const graphNode = node("contract-tamper", { sideEffect: "none" });
	const prepared = await prepareV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspace: "shadow" });
	const contractPath = join(prepared.workspaceCwd, ".pi-graph", "node-contract.json");
	const contract = JSON.parse(await readFile(contractPath, "utf8")) as Record<string, unknown>;
	contract.allowBash = true;
	await writeFile(contractPath, JSON.stringify(contract), "utf8");
	await assert.rejects(
		reopenV3Workspace({ runInstanceId: "r1", graphId: "g1", node: graphNode, attempt: 1, runDir, sourceCwd, workspaceCwd: prepared.workspaceCwd, kind: "shadow" }),
		/workspace contract no longer matches/i,
	);
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

test("V3 workspace recovers the V1 SIGKILL window before the indexed copy", async () => {
	const { sandbox, sourceCwd, runDir } = await workspaceFixture();
	const sourcePath = join(sourceCwd, "target.txt");
	await writeFile(sourcePath, "before\n", "utf8");
	const graphNode = node("apply-crash-before-copy", {
		writeScope: [{ kind: "file", path: "target.txt" }],
		validationCommands: ["test -f target.txt"],
	});
	const prepared = await prepareV3Workspace({
		runInstanceId: "r1",
		graphId: "g1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspace: "shadow",
	});
	const workspacePath = join(prepared.workspaceCwd, "target.txt");
	await writeFile(workspacePath, "after\n", "utf8");
	const before = await digestFile(sourcePath);
	const after = await digestFile(workspacePath);
	assert.ok(before && after);
	const attemptDir = v3NodeAttemptDir(runDir, graphNode.taskId, 1);
	const planPath = join(attemptDir, "apply-plan.json");
	const fixturePath = join(sandbox, "apply-crash-fixture.json");
	await writeFile(fixturePath, JSON.stringify({
		planPath,
		plan: {
			version: 1,
			status: "applying",
			entries: [{ sourcePath, before, after }],
			attemptDir,
			workspaceCwd: prepared.workspaceCwd,
			contractDigest: prepared.evidence.contractDigest,
			// V1 persisted this before atomicCopy. SIGKILL now leaves sourcePath
			// in its before-state even though the cursor points at entry zero.
			applyingIndex: 0,
		},
	}, null, 2), "utf8");
	const driver = resolve(process.cwd(), "tests/helpers/v3-workspace-apply-crash-driver.ts");
	const child = spawn(process.execPath, ["--experimental-strip-types", driver, fixturePath], {
		cwd: process.cwd(),
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolveExit, reject) => {
		let stderr = "";
		child.stderr!.setEncoding("utf8");
		child.stderr!.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("exit", (code, signal) => resolveExit({ code, signal, stderr }));
	});
	assert.equal(exit.signal, "SIGKILL", exit.stderr);
	assert.equal(await readFile(sourcePath, "utf8"), "before\n");

	const reopened = await reopenV3Workspace({
		runInstanceId: "r1",
		graphId: "g1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspaceCwd: prepared.workspaceCwd,
		kind: "shadow",
	});
	await reopened.apply();
	assert.equal(await readFile(sourcePath, "utf8"), "after\n");
	const recoveredPlan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
	assert.equal(recoveredPlan.version, 2);
	assert.equal(recoveredPlan.status, "committed");
	assert.equal(recoveredPlan.lastCommittedIndex, 0);
	assert.ok(!("applyingIndex" in recoveredPlan));
	await reopened.cleanup();
});

test("V3 workspace recovers SIGKILL after a copy but before its completion checkpoint", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	const firstPath = join(sourceCwd, "first.txt");
	const secondPath = join(sourceCwd, "second.txt");
	await writeFile(firstPath, "first-before\n", "utf8");
	await writeFile(secondPath, "second-before\n", "utf8");
	const graphNode = node("apply-crash-after-copy", {
		writeScope: [
			{ kind: "file", path: "first.txt" },
			{ kind: "file", path: "second.txt" },
		],
		validationCommands: ["test -f first.txt", "test -f second.txt"],
	});
	const prepared = await prepareV3Workspace({
		runInstanceId: "r1",
		graphId: "g1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspace: "shadow",
	});
	const firstWorkspace = join(prepared.workspaceCwd, "first.txt");
	const secondWorkspace = join(prepared.workspaceCwd, "second.txt");
	await writeFile(firstWorkspace, "first-after\n", "utf8");
	await writeFile(secondWorkspace, "second-after\n", "utf8");
	const firstBefore = await digestFile(firstPath);
	const firstAfter = await digestFile(firstWorkspace);
	const secondBefore = await digestFile(secondPath);
	const secondAfter = await digestFile(secondWorkspace);
	assert.ok(firstBefore && firstAfter && secondBefore && secondAfter);
	const attemptDir = v3NodeAttemptDir(runDir, graphNode.taskId, 1);
	await mkdir(attemptDir, { recursive: true });
	const planPath = join(attemptDir, "apply-plan.json");
	await writeFile(planPath, `${JSON.stringify({
		version: 2,
		status: "applying",
		entries: [
			{ sourcePath: firstPath, before: firstBefore, after: firstAfter, backupPath: join(attemptDir, "backups", "first.bak") },
			{ sourcePath: secondPath, before: secondBefore, after: secondAfter, backupPath: join(attemptDir, "backups", "second.bak") },
		],
		attemptDir,
		workspaceCwd: prepared.workspaceCwd,
		contractDigest: prepared.evidence.contractDigest,
		lastCommittedIndex: -1,
	}, null, 2)}\n`, "utf8");
	// The first rename reached disk, but SIGKILL happened before journal progress.
	await writeFile(firstPath, "first-after\n", "utf8");
	await prepared.apply();
	assert.equal(await readFile(firstPath, "utf8"), "first-after\n");
	assert.equal(await readFile(secondPath, "utf8"), "second-after\n");
	const recoveredPlan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
	assert.equal(recoveredPlan.status, "committed");
	assert.equal(recoveredPlan.lastCommittedIndex, 1);
	await prepared.cleanup();
});

test("V3 recovery rejects a third digest for a pending deletion", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	const sourcePath = join(sourceCwd, "delete-me.txt");
	await writeFile(sourcePath, "before\n", "utf8");
	const graphNode = node("delete-recovery-conflict", {
		writeScope: [{ kind: "file", path: "delete-me.txt" }],
		validationCommands: ["test ! -e delete-me.txt"],
	});
	const prepared = await prepareV3Workspace({
		runInstanceId: "r1",
		graphId: "g1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspace: "shadow",
	});
	const before = await digestFile(sourcePath);
	assert.ok(before);
	await import("node:fs/promises").then((fs) => fs.rm(join(prepared.workspaceCwd, "delete-me.txt")));
	const attemptDir = v3NodeAttemptDir(runDir, graphNode.taskId, 1);
	await mkdir(attemptDir, { recursive: true });
	await writeFile(join(attemptDir, "apply-plan.json"), `${JSON.stringify({
		version: 2,
		status: "applying",
		entries: [{ sourcePath, before, deleted: true, backupPath: join(attemptDir, "backups", "delete.bak") }],
		attemptDir,
		workspaceCwd: prepared.workspaceCwd,
		contractDigest: prepared.evidence.contractDigest,
		lastCommittedIndex: -1,
	}, null, 2)}\n`, "utf8");
	await writeFile(sourcePath, "concurrent-third-digest\n", "utf8");
	await assert.rejects(() => prepared.apply(), V3WorkspaceConflictError);
	assert.equal(await readFile(sourcePath, "utf8"), "concurrent-third-digest\n");
	await prepared.cleanup();
});

test("V3 recovery rechecks every later entry after preflight and preserves concurrent edits", async () => {
	const { sourceCwd, runDir } = await workspaceFixture();
	const firstPath = join(sourceCwd, "first.txt");
	const secondPath = join(sourceCwd, "second.txt");
	await writeFile(firstPath, "first-before\n", "utf8");
	await writeFile(secondPath, "second-before\n", "utf8");
	const graphNode = node("multi-recovery-conflict", {
		writeScope: [
			{ kind: "file", path: "first.txt" },
			{ kind: "file", path: "second.txt" },
		],
		validationCommands: ["test -f first.txt", "test -f second.txt"],
	});
	const prepared = await prepareV3Workspace({
		runInstanceId: "r1",
		graphId: "g1",
		node: graphNode,
		attempt: 1,
		runDir,
		sourceCwd,
		workspace: "shadow",
	});
	const firstWorkspace = join(prepared.workspaceCwd, "first.txt");
	const secondWorkspace = join(prepared.workspaceCwd, "second.txt");
	await writeFile(firstWorkspace, "first-after\n", "utf8");
	await writeFile(secondWorkspace, "second-after\n", "utf8");
	const firstBefore = await digestFile(firstPath);
	const firstAfter = await digestFile(firstWorkspace);
	const secondBefore = await digestFile(secondPath);
	const secondAfter = await digestFile(secondWorkspace);
	assert.ok(firstBefore && firstAfter && secondBefore && secondAfter);
	const attemptDir = v3NodeAttemptDir(runDir, graphNode.taskId, 1);
	await mkdir(attemptDir, { recursive: true });
	await writeFile(join(attemptDir, "apply-plan.json"), `${JSON.stringify({
		version: 2,
		status: "applying",
		entries: [
			{ sourcePath: firstPath, before: firstBefore, after: firstAfter, backupPath: join(attemptDir, "backups", "first.bak") },
			{ sourcePath: secondPath, before: secondBefore, after: secondAfter, backupPath: join(attemptDir, "backups", "second.bak") },
		],
		attemptDir,
		workspaceCwd: prepared.workspaceCwd,
		contractDigest: prepared.evidence.contractDigest,
		lastCommittedIndex: -1,
	}, null, 2)}\n`, "utf8");
	// Model a crash after the first rename but before its completion checkpoint.
	await writeFile(firstPath, "first-after\n", "utf8");
	let injected = false;
	const concurrentEditAfterPreflight = {
		get aborted() {
			// recoverApplyPlan reads the signal only after its full preflight. Inject
			// the edit at that boundary so the per-entry CAS must catch it later.
			if (!injected) {
				writeFileSync(secondPath, "second-concurrent\n", "utf8");
				injected = true;
			}
			return false;
		},
	} as AbortSignal;
	await assert.rejects(() => prepared.apply(concurrentEditAfterPreflight), V3WorkspaceConflictError);
	assert.equal(injected, true);
	assert.equal(await readFile(firstPath, "utf8"), "first-after\n");
	assert.equal(await readFile(secondPath, "utf8"), "second-concurrent\n");
	const unchangedPlan = JSON.parse(await readFile(join(attemptDir, "apply-plan.json"), "utf8")) as Record<string, unknown>;
	assert.equal(unchangedPlan.lastCommittedIndex, 0);
	assert.equal(unchangedPlan.status, "applying");
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
