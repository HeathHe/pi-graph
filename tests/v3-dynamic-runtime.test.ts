import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { V3RevisionConflictError } from "../src/v3/mutations.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphNodeSpecV3, GraphSpecV3 } from "../src/v3/types.ts";
import { freezeV3GraphAgents } from "../src/v3/workspace.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

async function fixture() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-dynamic-runtime-")));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(runsDir, { recursive: true })]);
	const mock = new MockSubagents();
	mock.start();
	const host = new V3GraphHost({
		rpc: new SubagentRpcClient(mock),
		runsDir,
		sessionId: "dynamic-session",
		supervisorEpoch: "dynamic-epoch",
		preflightAgent: async () => undefined,
	});
	return { sandbox, sourceDir, runsDir, mock, host };
}

function openSpec(graphId: string, nodes: GraphNodeSpecV3[] = []): GraphSpecV3 {
	return { schemaVersion: 3, graphId, goal: "exercise a live dynamic graph", mode: "open", maxConcurrency: 3, nodes };
}

function node(taskId: string, task: string, dependsOn: string[] = []): GraphNodeSpecV3 {
	return { taskId, agent: "test-agent", task, ...(dependsOn.length ? { dependsOn } : {}), sideEffect: "none" };
}

async function waitFor(
	read: () => Promise<import("../src/v3/types.ts").GraphSnapshotV3>,
	accept: (snapshot: import("../src/v3/types.ts").GraphSnapshotV3) => boolean,
	label: string,
) {
	// Node's test runner executes files concurrently; real Pi subprocesses,
	// SIGKILL recovery, graph startup, and workspace fsyncs share the same four
	// test slots in the full regression suite. Allow that observed load without
	// weakening any state predicate or production deadline.
	const deadline = Date.now() + 60_000;
	let latest: import("../src/v3/types.ts").GraphSnapshotV3 | undefined;
	while (Date.now() < deadline) {
		latest = await read();
		if (accept(latest)) return latest;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
	throw new Error(`Timed out waiting for ${label}; last snapshot=${JSON.stringify(latest)}`);
}

test("OPEN host replays immutable authorization plus journal, wakes on append, and completes only after seal", async () => {
	const f = await fixture();
	try {
		f.mock.behaviors.set("DYNAMIC_WORK", (input) => completeChild({ ...input, output: "dynamic result" }));
		const handle = await f.host.start(openSpec("dynamic-empty"), f.sourceDir);
		const empty = await f.host.waitForCompletion(handle.graphId);
		assert.equal(empty.status, "idle");
		assert.equal(empty.topology, "open");
		assert.equal(empty.sealed, false);
		assert.equal(empty.revision, 0);

		const appended = await f.host.append(handle.graphId, [node("work", "DYNAMIC_WORK")], 0);
		assert.equal(appended.revision, 1);
		const idle = await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.status === "idle" && snapshot.nodes?.work?.phase === "accepted",
			"appended work to settle to OPEN idle",
		);
		assert.equal(idle.revision, 1);
		assert.equal(idle.sealed, false);
		assert.equal((await readLatestV3Attempt(handle.runDir, "work"))?.attempt, 1);
		const loaded = await f.host.loadRun(handle.runDir, handle.graphId);
		assert.equal(loaded.baseGraph.nodes.length, 0, "authorization source remains immutable");
		assert.deepEqual(loaded.graph.nodes.map((entry) => entry.taskId), ["work"]);
		assert.equal(loaded.mutation.revision, 1);

		await assert.rejects(
			f.host.append(handle.graphId, [node("stale", "DYNAMIC_WORK")], 0),
			(error: unknown) => error instanceof V3RevisionConflictError && error.currentRevision === 1,
		);
		const sealed = await f.host.seal(handle.graphId, 1);
		assert.equal(sealed.revision, 2);
		const terminal = await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.status === "complete",
			"sealed graph to complete",
		);
		assert.equal(terminal.sealed, true);
		assert.equal(terminal.revision, 2);
		await f.host.waitForCompletion(handle.graphId);
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("OPEN host replaces a frozen profile orphaned before append authority", async () => {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-dynamic-profile-recovery-")));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await Promise.all([
		mkdir(join(sourceDir, ".pi", "agents"), { recursive: true }),
		mkdir(runsDir, { recursive: true }),
	]);
	await writeFile(join(sourceDir, ".pi", "agents", "old-agent.md"), "---\nname: old-agent\ndescription: Old profile\n---\n\nOld instructions.\n", "utf8");
	await writeFile(join(sourceDir, ".pi", "agents", "new-agent.md"), "---\nname: new-agent\ndescription: New profile\n---\n\nNew instructions.\n", "utf8");
	const mock = new MockSubagents();
	mock.start();
	const host = new V3GraphHost({
		rpc: new SubagentRpcClient(mock),
		runsDir,
		sessionId: "profile-recovery-session",
		supervisorEpoch: "profile-recovery-epoch",
	});
	try {
		mock.behaviors.set("PROFILE_RECOVERY", (input) => completeChild({ ...input, output: "profile recovered" }));
		const handle = await host.start(openSpec("dynamic-profile-recovery"), sourceDir);
		await host.waitForCompletion(handle.graphId);
		const staleSpec: GraphSpecV3 = openSpec(handle.graphId, [{
			taskId: "late",
			agent: "old-agent",
			task: "STALE_PROFILE",
			sideEffect: "none",
		}]);
		const staleNode = compileGraphSpecV3(staleSpec).nodes[0]!;
		await freezeV3GraphAgents(handle.runDir, sourceDir, [staleNode]);

		await host.append(handle.graphId, [{
			taskId: "late",
			agent: "new-agent",
			task: "PROFILE_RECOVERY",
			sideEffect: "none",
		}], 0);
		const settled = await waitFor(
			() => host.status(handle.graphId),
			(snapshot) => snapshot.nodes?.late?.phase === "accepted",
			"orphan-profile replacement node",
		);
		assert.equal(settled.nodes?.late?.phase, "accepted");
		const frozen = await readFile(join(handle.runDir, "agent-profiles", "late.json"), "utf8");
		assert.match(frozen, /New instructions/u);
		assert.doesNotMatch(frozen, /Old instructions/u);
		assert.equal((await host.waitForCompletion(handle.graphId)).status, "idle");
	} finally {
		await mock.dispose();
		await rm(sandbox, { recursive: true, force: true });
	}
});

test("when:failed waits for every direct dependency, receives bounded failure output, skips sibling without Attempt, and sealed graph stays failed", async () => {
	const f = await fixture();
	let releaseOther: (() => void) | undefined;
	try {
		const otherGate = new Promise<void>((resolveGate) => { releaseOther = resolveGate; });
		f.mock.behaviors.set("FAIL_SOURCE", async (input) => {
			const outputFile = join(input.asyncDir, "output.txt");
			await writeFile(outputFile, "source failure evidence", "utf8");
			const current = JSON.parse(await readFile(join(input.asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
			await writeFile(join(input.asyncDir, "status.json"), JSON.stringify({
				...current,
				runId: input.asyncId,
				state: "failed",
				error: "synthetic failure",
				outputFile,
				sessionDir: join(input.asyncDir, "session"),
				mode: "single",
			}), "utf8");
		});
		f.mock.behaviors.set("SLOW_OTHER", async (input) => {
			await otherGate;
			await completeChild({ ...input, output: "other accepted output" });
		});
		f.mock.behaviors.set("RUN_REPAIR", (input) => completeChild({ ...input, output: "repair accepted" }));
		f.mock.behaviors.set("MUST_SKIP", (input) => completeChild({ ...input, output: "must not run" }));

		const handle = await f.host.start(openSpec("dynamic-when", [
			node("source", "FAIL_SOURCE"),
			node("other", "SLOW_OTHER"),
			{ ...node("repair", "RUN_REPAIR", ["other", "source"]), when: { node: "source", status: "failed" } },
			{ ...node("publish", "MUST_SKIP", ["source"]), when: { node: "source", status: "accepted" } },
		]), f.sourceDir);

		await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.nodes?.source?.phase === "failed",
			"source failure",
		);
		assert.equal(f.mock.spawned.some((entry) => String(entry.params.task).includes("RUN_REPAIR")), false, "repair must wait for other dependency");
		releaseOther?.();
		const idle = await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.status === "idle" && snapshot.nodes?.repair?.phase === "accepted" && snapshot.nodes?.publish?.phase === "skipped",
			"conditional branches to settle",
		);
		assert.equal(idle.nodes?.publish?.attempt, 0);
		assert.equal(await readLatestV3Attempt(handle.runDir, "publish"), undefined, "skipped branch must not invent an Attempt");
		const repairRequest = f.mock.spawned.find((entry) => String(entry.params.task).includes("RUN_REPAIR"));
		assert.ok(repairRequest);
		const task = String(repairRequest.params.task);
		assert.ok(task.indexOf('"taskId": "other"') < task.indexOf('"taskId": "source"'), "capsule preserves declared dependency order");
		assert.match(task, /source failure evidence/u);
		assert.equal(repairRequest.params.agentScope, "project");
		assert.notEqual(repairRequest.params.cwd, f.sourceDir, "child runs only in its shadow workspace");

		await f.host.seal(handle.graphId, 0);
		const failed = await waitFor(() => f.host.status(handle.graphId), (snapshot) => snapshot.status === "failed", "sealed failure result");
		assert.equal(failed.nodes?.repair?.phase, "accepted");
		assert.equal(failed.nodes?.source?.phase, "failed", "repair does not erase original failure authority");
		await f.host.waitForCompletion(handle.graphId);
	} finally {
		releaseOther?.();
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("when:failed rejects a failed dependency whose persisted Attempt identity does not match its path", async () => {
	const f = await fixture();
	let releaseOther: (() => void) | undefined;
	try {
		const otherGate = new Promise<void>((resolveGate) => { releaseOther = resolveGate; });
		f.mock.behaviors.set("FAIL_IDENTITY_SOURCE", async (input) => {
			const outputFile = join(input.asyncDir, "output.txt");
			await writeFile(outputFile, "bounded failure evidence", "utf8");
			const current = JSON.parse(await readFile(join(input.asyncDir, "status.json"), "utf8")) as Record<string, unknown>;
			await writeFile(join(input.asyncDir, "status.json"), JSON.stringify({
				...current,
				runId: input.asyncId,
				state: "failed",
				error: "synthetic identity failure",
				outputFile,
				sessionDir: join(input.asyncDir, "session"),
				mode: "single",
			}), "utf8");
		});
		f.mock.behaviors.set("SLOW_IDENTITY_OTHER", async (input) => {
			await otherGate;
			await completeChild({ ...input, output: "other accepted output" });
		});
		f.mock.behaviors.set("MUST_NOT_REPAIR_IDENTITY", (input) => completeChild({ ...input, output: "must not run" }));

		const handle = await f.host.start(openSpec("dynamic-failed-identity", [
			node("source", "FAIL_IDENTITY_SOURCE"),
			node("other", "SLOW_IDENTITY_OTHER"),
			{ ...node("repair", "MUST_NOT_REPAIR_IDENTITY", ["source", "other"]), when: { node: "source", status: "failed" } },
		]), f.sourceDir);

		await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.nodes?.source?.phase === "failed",
			"failed identity source",
		);
		const sourceAttempt = await readLatestV3Attempt(handle.runDir, "source");
		assert.ok(sourceAttempt);
		const sourceAttemptPath = join(handle.runDir, "nodes", "source", "attempts", String(sourceAttempt.attempt), "attempt.json");
		const tampered = JSON.parse(await readFile(sourceAttemptPath, "utf8")) as Record<string, unknown>;
		tampered.graphId = "different-graph";
		await writeFile(sourceAttemptPath, `${JSON.stringify(tampered)}\n`, "utf8");

		releaseOther?.();
		const rejected = await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.nodes?.repair?.phase === "needs_attention",
			"failed dependency identity rejection",
		);
		assert.equal(rejected.status, "needs_attention");
		assert.equal(f.mock.spawned.some((entry) => String(entry.params.task).includes("MUST_NOT_REPAIR_IDENTITY")), false);
		const repairAttempt = await readLatestV3Attempt(handle.runDir, "repair");
		assert.equal(repairAttempt?.evidence.failure?.kind, "dispatch_unknown");
		assert.match(repairAttempt?.evidence.failure?.message ?? "", /Attempt path and payload identity disagree/u);
		await f.host.waitForCompletion(handle.graphId);
	} finally {
		releaseOther?.();
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("cancel tombstone and propagated block stay Attempt-free and do not poison sealed success", async () => {
	const f = await fixture();
	try {
		let releaseGate!: () => void;
		const gate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
		f.mock.behaviors.set("RUN_GATE", async (input) => {
			await gate;
			await completeChild({ ...input, output: "gate accepted" });
		});
		const handle = await f.host.start(openSpec("dynamic-cancel"), f.sourceDir);
		await f.host.waitForCompletion(handle.graphId);
		await f.host.append(handle.graphId, [
			node("gate", "RUN_GATE"),
			node("cancel-me", "NEVER_RUN", ["gate"]),
			node("child", "NEVER_CHILD", ["cancel-me"]),
		], 0);
		await waitFor(() => f.host.status(handle.graphId), (snapshot) => snapshot.nodes?.gate?.phase === "running", "gate dispatch");
		const cancelled = await f.host.cancel(handle.graphId, ["cancel-me"], false, 1);
		assert.deepEqual(cancelled.cancelledTaskIds, ["cancel-me"]);
		releaseGate();
		const idle = await waitFor(
			() => f.host.status(handle.graphId),
			(snapshot) => snapshot.status === "idle" && snapshot.nodes?.["cancel-me"]?.phase === "cancelled" && snapshot.nodes?.child?.phase === "blocked",
			"cancel projection",
		);
		assert.equal(idle.nodes?.["cancel-me"]?.attempt, 0);
		assert.equal(idle.nodes?.child?.attempt, 0);
		assert.equal(await readLatestV3Attempt(handle.runDir, "cancel-me"), undefined);
		assert.equal(await readLatestV3Attempt(handle.runDir, "child"), undefined);
		assert.deepEqual(f.mock.spawned.map((entry) => String(entry.params.task).split("\n", 1)[0]), ["RUN_GATE"]);

		await f.host.seal(handle.graphId, 2);
		const complete = await waitFor(() => f.host.status(handle.graphId), (snapshot) => snapshot.status === "complete", "cancelled sealed success");
		assert.equal(complete.revision, 3);
		await f.host.waitForCompletion(handle.graphId);
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});
