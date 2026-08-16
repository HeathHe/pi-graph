import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { readV3AcceptanceEvidence, readV3ValidatedResult, readV3WorkspaceEvidence } from "../src/v3/attempt.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { V3GraphRunner } from "../src/v3/runner.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild, failChild, pauseChild } from "./helpers/mock-subagents.ts";

async function setupRun() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-runner-")));
	const sourceDir = join(sandbox, "source");
	await mkdir(sourceDir, { recursive: true });
	const runsDir = join(sandbox, "runs");
	await mkdir(runsDir, { recursive: true });
	const graphDir = join(runsDir, "graph-test");
	const runInstanceId = "run-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	const runDir = join(graphDir, runInstanceId);
	return { sandbox, sourceDir, runsDir, graphDir, runDir, runInstanceId };
}

async function launch(
	sandboxInfo: ReturnType<typeof setupRun> extends Promise<infer T> ? T : never,
	spec: GraphSpecV3,
	mock: MockSubagents,
	options: { maxConcurrency?: number; failFast?: boolean; preflightAgent?: (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void> } = {},
) {
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const { runDir, runInstanceId } = sandboxInfo;
	const init = await initializeV3Run({
		trustedRoot: resolve(sandboxInfo.runsDir),
		runDir,
		graph,
		sessionId: "session-test",
		supervisorEpoch: "epoch-1",
		sourceCwd: sandboxInfo.sourceDir,
		runInstanceId,
	});
	const runner = new V3GraphRunner({
		rpc,
		runDir,
		graph,
		authorization: init.authorization,
		sourceCwd: sandboxInfo.sourceDir,
		sessionId: "session-test",
		supervisorEpoch: "epoch-1",
		...(options.maxConcurrency === undefined ? {} : { maxConcurrency: options.maxConcurrency }),
		...(options.failFast === undefined ? {} : { failFast: options.failFast }),
		...(options.preflightAgent ? { preflightAgent: options.preflightAgent } : {}),
	});
	const snapshot = await runner.run();
	return { graph, init, snapshot, runDir };
}

test("V3 runner executes a three-node A/B-parallel-then-C graph end to end", async () => {
	const sandboxInfo = await setupRun();
	await writeFile(join(sandboxInfo.sourceDir, "input.txt"), "seed\n", "utf8");
	const mock = new MockSubagents();
	mock.behaviors.set("NODE_A", (input) => completeChild({ ...input, writes: [{ path: "out-a.txt", content: "a\n" }] }));
	mock.behaviors.set("NODE_B", (input) => completeChild({ ...input, writes: [{ path: "out-b.txt", content: "b\n" }] }));
	mock.behaviors.set("NODE_C", (input) => completeChild({ ...input, output: "c-output" }));
	mock.start();
	const noopPreflight = async () => undefined;
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "write a and b then c",
		maxConcurrency: 2,
		nodes: [
			{ taskId: "node-a", agent: "test-agent", task: "NODE_A write out-a.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-a.txt" }], validationCommands: ["test -f out-a.txt"] },
			{ taskId: "node-b", agent: "test-agent", task: "NODE_B write out-b.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-b.txt" }], validationCommands: ["test -f out-b.txt"] },
			{ taskId: "node-c", agent: "test-agent", task: "NODE_C depends on both", dependsOn: ["node-a", "node-b"], sideEffect: "local_read", readScope: [{ kind: "file", path: "input.txt" }] },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: noopPreflight });
	assert.equal(snapshot.status, "complete");
	const aApplied = await readFile(join(sandboxInfo.sourceDir, "out-a.txt"), "utf8");
	const bApplied = await readFile(join(sandboxInfo.sourceDir, "out-b.txt"), "utf8");
	assert.equal(aApplied, "a\n");
	assert.equal(bApplied, "b\n");
	const aAttempt = await readLatestV3Attempt(runDir, "node-a");
	assert.ok(aAttempt);
	assert.equal(aAttempt.evidence.phase, "accepted");
	assert.ok(aAttempt.evidence.applied, "applied writes recorded");
	const aWorkspace = await readV3WorkspaceEvidence(runDir, "node-a", aAttempt.attempt);
	assert.ok(aWorkspace);
	assert.ok(aWorkspace.writeBaseline[resolve(sandboxInfo.sourceDir, "out-a.txt")] === null, "baseline recorded null for absent source file");
	const aValidated = await readV3ValidatedResult(runDir, "node-a", aAttempt.attempt);
	assert.ok(aValidated && aValidated.allPassed);
	const aAcceptance = await readV3AcceptanceEvidence(runDir, "node-a", aAttempt.attempt);
	assert.ok(aAcceptance);
	assert.equal(aAcceptance.method, "machine-verified");
	assert.ok(aAcceptance.attemptDigest);
	// C must have been dispatched after both A and B were accepted.
	const cDispatch = (await readLatestV3Attempt(runDir, "node-c"))!.evidence.dispatch!;
	const aDispatch = (await readLatestV3Attempt(runDir, "node-a"))!.evidence.dispatch!;
	const bDispatch = (await readLatestV3Attempt(runDir, "node-b"))!.evidence.dispatch!;
	assert.ok(Date.parse(cDispatch.dispatchedAt) >= Date.parse(aDispatch.dispatchedAt));
	assert.ok(Date.parse(cDispatch.dispatchedAt) >= Date.parse(bDispatch.dispatchedAt));
	// A and B were both in flight at some point (parallel launch).
	const aStart = Date.parse(aDispatch.dispatchedAt);
	const bStart = Date.parse(bDispatch.dispatchedAt);
	assert.ok(Math.abs(aStart - bStart) < 2_000, "A and B dispatched near-simultaneously");
	// Events written as unverified shadow lines.
	const events = await readFile(join(runDir, "events.jsonl"), "utf8");
	const lines = events.trim().split("\n").filter(Boolean);
	assert.ok(lines.length >= 8, `expected event lines, got ${lines.length}`);
	for (const line of lines.slice(0, 3)) {
		const event = JSON.parse(line);
		assert.equal(event.schemaVersion, 1);
		assert.equal(event.unverified, true);
	}
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner retries a failed local_write node per retryPolicy", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	let attempts = 0;
	mock.behaviors.set("FLAKY", async (input) => {
		attempts += 1;
		if (attempts === 1) await failChild(input);
		else await completeChild({ ...input, writes: [{ path: "flaky.txt", content: "ok\n" }] });
	});
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "flaky retry",
		nodes: [
			{
				taskId: "flaky",
				agent: "test-agent",
				task: "FLAKY node",
				sideEffect: "local_write",
				writeScope: [{ kind: "file", path: "flaky.txt" }],
				validationCommands: ["test -f flaky.txt"],
				retryPolicy: { maxAttempts: 3, retryOn: ["task_failed"], backoffMs: 50 },
			},
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "complete");
	assert.ok(attempts >= 2, "node was retried");
	const latest = await readLatestV3Attempt(runDir, "flaky");
	assert.equal(latest!.evidence.phase, "accepted");
	assert.equal(latest!.evidence.attempt, attempts);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner enters needs_attention on ambiguous child identity", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("AMBIG", async (input) => {
		// Write a status with a mismatched runId so monitoring cannot confirm identity.
		await writeFile(join(input.asyncDir, "status.json"), JSON.stringify({ runId: "wrong-id", state: "complete", sessionDir: join(input.asyncDir, "session"), mode: "single" }));
	});
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "ambiguous",
		nodes: [
			{ taskId: "ambig", agent: "test-agent", task: "AMBIG node", sideEffect: "local_read" },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "needs_attention");
	const latest = await readLatestV3Attempt(runDir, "ambig");
	assert.equal(latest!.evidence.phase, "needs_attention");
	assert.equal(latest!.evidence.terminalStatus, "needs_attention");
	assert.equal(latest!.evidence.failure!.kind, "dispatch_unknown");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner reports workspace conflict instead of silently overwriting concurrent edits", async () => {
	const sandboxInfo = await setupRun();
	await writeFile(join(sandboxInfo.sourceDir, "out.txt"), "original\n", "utf8");
	const mock = new MockSubagents();
	// Deterministic ordering: the child writes its workspace file, signals via an
	// in-process flag, then waits for the concurrent source edit before completing.
	// The test writes the edit as soon as the flag fires, so apply always observes
	// the changed source regardless of wall-clock load.
	let signalChildStarted: (() => void) | undefined;
	const childStarted = new Promise<void>((resolvePromise) => { signalChildStarted = resolvePromise; });
	mock.behaviors.set("CONFLICT", async (input) => {
		await writeFile(join(input.cwd, "out.txt"), "child-edit\n", "utf8");
		signalChildStarted?.();
		// Wait until the concurrent source edit lands (bounded to avoid a hang).
		for (let i = 0; i < 2000; i += 1) {
			let text = "";
			try {
				text = await readFile(join(sandboxInfo.sourceDir, "out.txt"), "utf8");
			} catch {
				/* not yet */
			}
			if (text === "concurrent-edit\n") break;
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		}
		await completeChild(input);
	});
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "conflict",
		nodes: [
			{
				taskId: "conflict",
				agent: "test-agent",
				task: "CONFLICT node",
				sideEffect: "local_write",
				writeScope: [{ kind: "file", path: "out.txt" }],
				validationCommands: ["test -f out.txt"],
			},
		],
	};
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: resolve(sandboxInfo.runsDir), runDir: sandboxInfo.runDir, graph, sessionId: "session-test", supervisorEpoch: "epoch-1", sourceCwd: sandboxInfo.sourceDir, runInstanceId: sandboxInfo.runInstanceId });
	const runner = new V3GraphRunner({ rpc, runDir: sandboxInfo.runDir, graph, authorization: init.authorization, sourceCwd: sandboxInfo.sourceDir, sessionId: "session-test", supervisorEpoch: "epoch-1", preflightAgent: async () => undefined });
	const snapshotPromise = runner.run();
	// Land the concurrent edit once the child has started its workspace edit.
	await childStarted;
	await writeFile(join(sandboxInfo.sourceDir, "out.txt"), "concurrent-edit\n", "utf8");
	const snapshot = await snapshotPromise;
	assert.ok(["failed", "needs_attention"].includes(snapshot.status), `expected failure, got ${snapshot.status}`);
	const latest = await readLatestV3Attempt(sandboxInfo.runDir, "conflict");
	assert.equal(latest!.evidence.failure!.kind, "workspace_conflict");
	// The concurrent edit must not be overwritten.
	assert.equal(await readFile(join(sandboxInfo.sourceDir, "out.txt"), "utf8"), "concurrent-edit\n");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner requestStop aborts in-flight nodes and marks remaining aborted", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	const hang = new Promise<void>(() => undefined);
	mock.behaviors.set("SLOW", () => hang);
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "stop",
		nodes: [
			{ taskId: "slow", agent: "test-agent", task: "SLOW node", sideEffect: "local_read" },
			{ taskId: "later", agent: "test-agent", task: "LATER node", dependsOn: ["slow"], sideEffect: "local_read" },
		],
	};
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: resolve(sandboxInfo.runsDir), runDir: sandboxInfo.runDir, graph, sessionId: "session-test", supervisorEpoch: "epoch-1", sourceCwd: sandboxInfo.sourceDir, runInstanceId: sandboxInfo.runInstanceId });
	const runner = new V3GraphRunner({ rpc, runDir: sandboxInfo.runDir, graph, authorization: init.authorization, sourceCwd: sandboxInfo.sourceDir, sessionId: "session-test", supervisorEpoch: "epoch-1", preflightAgent: async () => undefined });
	const runPromise = runner.run();
	await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
	runner.requestStop();
	const snapshot = await runPromise;
	assert.equal(snapshot.status, "stopped");
	const slow = await readLatestV3Attempt(sandboxInfo.runDir, "slow");
	assert.equal(slow!.evidence.phase, "aborted");
	const later = await readLatestV3Attempt(sandboxInfo.runDir, "later");
	assert.equal(later!.evidence.phase, "aborted");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner marks a paused child as child_paused without resuming it", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("PAUSED", (input) => pauseChild(input));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "paused",
		nodes: [
			{ taskId: "paused", agent: "test-agent", task: "PAUSED node", sideEffect: "local_read" },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "failed");
	const latest = await readLatestV3Attempt(runDir, "paused");
	assert.equal(latest!.evidence.failure!.kind, "child_paused");
	assert.equal(latest!.evidence.child!.terminal, "paused");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner projection reflects queued then complete node states", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("P1", (input) => completeChild({ ...input, output: "p1" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "projection",
		nodes: [
			{ taskId: "p1", agent: "test-agent", task: "P1 node", sideEffect: "local_read" },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "complete");
	assert.ok(snapshot.nodes);
	assert.equal(snapshot.nodes["p1"]!.phase, "accepted");
	assert.equal(snapshot.nodes["p1"]!.attempt, 1);
	assert.equal(snapshot.nodes["p1"]!.terminalStatus, "accepted");
	// Snapshot file is a rebuildable projection.
	const persisted = JSON.parse(await readFile(join(runDir, "snapshot.json"), "utf8"));
	assert.equal(persisted.status, "complete");
	assert.equal(persisted.schemaVersion, 3);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner respects maxConcurrency by not launching C before A and B finish", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	// Gate A's completion so C cannot possibly start until A has been observed as
	// complete. Ordering is asserted on the spawn sequence (immune to timestamp jitter).
	const a = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 300));
	mock.behaviors.set("NODE_A2", async (input) => { await a; await completeChild({ ...input, output: "a2" }); });
	mock.behaviors.set("NODE_B2", (input) => completeChild({ ...input, output: "b2" }));
	mock.behaviors.set("NODE_C2", (input) => completeChild({ ...input, output: "c2" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "concurrency",
		maxConcurrency: 2,
		nodes: [
			{ taskId: "node-a2", agent: "test-agent", task: "NODE_A2 write", sideEffect: "local_read" },
			{ taskId: "node-b2", agent: "test-agent", task: "NODE_B2 write", sideEffect: "local_read" },
			{ taskId: "node-c2", agent: "test-agent", task: "NODE_C2 depends", dependsOn: ["node-a2", "node-b2"], sideEffect: "local_read" },
		],
	};
	const { snapshot } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "complete");
	const spawnOrder = mock.spawned.map((entry) => String(entry.params.task));
	const indexOfC = spawnOrder.findIndex((task) => task.includes("NODE_C2"));
	const indexOfA = spawnOrder.findIndex((task) => task.includes("NODE_A2"));
	const indexOfB = spawnOrder.findIndex((task) => task.includes("NODE_B2"));
	assert.ok(indexOfA >= 0 && indexOfB >= 0 && indexOfC >= 0, `all nodes dispatched, got order: ${spawnOrder.join(" | ")}`);
	// C must be spawned only after A completes: with maxConcurrency=2, C cannot start
	// until a slot frees, and C depends on both A and B.
	assert.ok(indexOfC > indexOfA, `C spawned after A, got order: ${spawnOrder.join(" | ")}`);
	assert.ok(indexOfC > indexOfB, `C spawned after B, got order: ${spawnOrder.join(" | ")}`);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});
