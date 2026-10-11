import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { readLatestV3Attempt, readV3AcceptanceEvidence, readV3ValidatedResult, readV3WorkspaceEvidence, verifyV3AcceptedAttemptChain } from "../src/v3/attempt.ts";
import { v3DispatchChild, v3StopChild } from "../src/v3/dispatch.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { V3GraphRunner } from "../src/v3/runner.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild, failChild, pauseChild, publishMockTerminal } from "./helpers/mock-subagents.ts";

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

test("V3 runner serializes local_write transactions before their fan-in", async () => {
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
	const aSpawn = mock.spawned.find((entry) => String(entry.params.task).includes("NODE_A"));
	assert.deepEqual((aSpawn?.params.extensionBindings as Record<string, unknown> | undefined)?.["pi-graph/1"], {
		schemaVersion: 1,
		graphId: aWorkspace.graphId,
		taskId: "node-a",
		attempt: 1,
		workspaceCwd: aWorkspace.workspaceDir,
		contractDigest: aWorkspace.contractDigest,
	}, "fresh dispatch must activate the Guard with the exact workspace contract digest");
	const aValidated = await readV3ValidatedResult(runDir, "node-a", aAttempt.attempt);
	assert.ok(aValidated && aValidated.allPassed);
	const aAcceptance = await readV3AcceptanceEvidence(runDir, "node-a", aAttempt.attempt);
	assert.ok(aAcceptance);
	assert.equal(aAcceptance.method, "machine-verified");
	assert.ok(aAcceptance.attemptDigest);
	assert.equal((await verifyV3AcceptedAttemptChain(runDir, "node-a", aAttempt.attempt, { method: "machine-verified" })).ok, true);
	assert.equal((await verifyV3AcceptedAttemptChain(runDir, "node-c", 1, { method: "declared" })).ok, true);
	assert.equal(await readFile(join(runDir, "artifacts", "node-a", "attempt-1.txt"), "utf8"), JSON.stringify({ taskId: "node-a", output: aAttempt.evidence.child!.output }));
	assert.equal(await readFile(join(runDir, "artifacts", "node-a.txt"), "utf8"), JSON.stringify({ taskId: "node-a", output: aAttempt.evidence.child!.output }));
	// C must have been dispatched after both A and B were accepted.
	const cDispatch = (await readLatestV3Attempt(runDir, "node-c"))!.evidence.dispatch!;
	const aDispatch = (await readLatestV3Attempt(runDir, "node-a"))!.evidence.dispatch!;
	const bDispatch = (await readLatestV3Attempt(runDir, "node-b"))!.evidence.dispatch!;
	assert.ok(Date.parse(cDispatch.dispatchedAt) >= Date.parse(aDispatch.dispatchedAt));
	assert.ok(Date.parse(cDispatch.dispatchedAt) >= Date.parse(bDispatch.dispatchedAt));
	// A and B are independent roots, but Graph-wide local_write transaction
	// serialization prevents B from dispatching until A is durably accepted.
	assert.ok(Date.parse(bDispatch.dispatchedAt) >= Date.parse(aAcceptance.recordedAt));
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

test("V3 runner never automatically repeats a failed local_write node", async () => {
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
	assert.equal(snapshot.status, "failed");
	assert.equal(attempts, 1, "write nodes cannot be retried automatically");
	const latest = await readLatestV3Attempt(runDir, "flaky");
	assert.equal(latest!.evidence.phase, "failed");
	assert.equal(latest!.evidence.attempt, attempts);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("V3 runner failFast stops new independent dispatches while admitted work finishes", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("FAIL_FAST_FAIL", (input) => failChild(input));
	mock.behaviors.set("FAIL_FAST_IN_FLIGHT", async (input) => {
		// Hold this admitted branch until the failure is durably observed. This
		// makes the dispatch-gate assertion independent of machine/test load.
		for (let index = 0; index < 500; index += 1) {
			if ((await readLatestV3Attempt(sandboxInfo.runDir, "failing"))?.evidence.phase === "failed") break;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		await completeChild({ ...input, output: "in-flight-finished" });
	});
	mock.behaviors.set("FAIL_FAST_NEVER", (input) => completeChild({ ...input, output: "must-not-run" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "fail fast across independent branches",
		failFast: true,
		maxConcurrency: 2,
		nodes: [
			{ taskId: "failing", agent: "test-agent", task: "FAIL_FAST_FAIL", sideEffect: "local_read" },
			{ taskId: "in-flight", agent: "test-agent", task: "FAIL_FAST_IN_FLIGHT", sideEffect: "local_read" },
			{ taskId: "never-start", agent: "test-agent", task: "FAIL_FAST_NEVER", sideEffect: "local_read" },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { failFast: true, preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "failed");
	assert.equal((await readLatestV3Attempt(runDir, "failing"))!.evidence.phase, "failed");
	assert.equal((await readLatestV3Attempt(runDir, "in-flight"))!.evidence.phase, "accepted", "already admitted work may finish");
	const neverStarted = (await readLatestV3Attempt(runDir, "never-start"))!.evidence;
	assert.equal(neverStarted.phase, "failed", "failFast records an explicit no-dispatch terminal state");
	assert.equal(neverStarted.dispatch, undefined);
	assert.match(neverStarted.failure?.message ?? "", /failed fast before this node started/u);
	assert.equal(snapshot.nodes?.["never-start"]?.phase, "failed");
	const spawnedTasks = mock.spawned.map((entry) => String(entry.params.task));
	assert.equal(spawnedTasks.some((task) => task.includes("FAIL_FAST_NEVER")), false, `unexpected dispatches: ${spawnedTasks.join(" | ")}`);
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

test("needs_attention closes the whole dispatch gate even when failFast is false", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("AMBIG_GATE", async (input) => {
		await writeFile(join(input.asyncDir, "status.json"), JSON.stringify({ runId: "wrong-id", state: "complete", sessionDir: join(input.asyncDir, "session"), mode: "single" }));
	});
	mock.behaviors.set("MUST_NOT_DISPATCH", (input) => completeChild({ ...input, output: "unexpected" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "needs attention gates independent work",
		maxConcurrency: 1,
		nodes: [
			{ taskId: "ambiguous", agent: "test-agent", task: "AMBIG_GATE", sideEffect: "local_read" },
			{ taskId: "independent", agent: "test-agent", task: "MUST_NOT_DISPATCH", sideEffect: "local_read" },
		],
	};
	const { snapshot, runDir } = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(snapshot.status, "needs_attention");
	assert.equal((await readLatestV3Attempt(runDir, "ambiguous"))?.evidence.phase, "needs_attention");
	assert.equal(await readLatestV3Attempt(runDir, "independent"), undefined);
	assert.equal(mock.spawned.some((entry) => String(entry.params.task).includes("MUST_NOT_DISPATCH")), false);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("resume verifies accepted evidence and does not redispatch a tampered immutable artifact", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("CHAIN_ROOT", (input) => completeChild({ ...input, output: "trusted-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "accepted chain recovery",
		nodes: [{ taskId: "root", agent: "test-agent", task: "CHAIN_ROOT", sideEffect: "local_read" }],
	};
	const launched = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	assert.equal(launched.snapshot.status, "complete");
	await writeFile(join(launched.runDir, "artifacts", "root", "attempt-1.txt"), "tampered", "utf8");
	const before = mock.spawned.length;
	const resumed = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock),
		runDir: launched.runDir,
		graph: launched.graph,
		authorization: launched.init.authorization,
		sourceCwd: sandboxInfo.sourceDir,
		sessionId: "session-test",
		supervisorEpoch: "epoch-2",
		preflightAgent: async () => undefined,
	});
	await resumed.initializeForResume();
	assert.equal((await resumed.run()).status, "needs_attention");
	assert.equal(mock.spawned.length, before, "tampered accepted evidence must never be redispatched automatically");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("a tampered accepted dependency stops an explicit descendant retry before dispatch", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("CHAIN_A", (input) => completeChild({ ...input, output: "a-output" }));
	mock.behaviors.set("CHAIN_B", (input) => completeChild({ ...input, output: "b-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "dependency chain retry",
		nodes: [
			{ taskId: "a", agent: "test-agent", task: "CHAIN_A", sideEffect: "local_read" },
			{ taskId: "b", agent: "test-agent", task: "CHAIN_B", dependsOn: ["a"], sideEffect: "local_read" },
		],
	};
	const launched = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	const workspacePath = join(launched.runDir, "nodes", "a", "attempts", "1", "workspace.json");
	const workspace = JSON.parse(await readFile(workspacePath, "utf8"));
	workspace.createdAt = new Date(Date.parse(workspace.createdAt) + 1_000).toISOString();
	await writeFile(workspacePath, JSON.stringify(workspace), "utf8");
	const before = mock.spawned.length;
	const resumed = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: launched.runDir, graph: launched.graph,
		authorization: launched.init.authorization, sourceCwd: sandboxInfo.sourceDir,
		sessionId: "session-test", supervisorEpoch: "epoch-2", retryBaselines: { b: 1 },
		preflightAgent: async () => undefined,
	});
	await resumed.initializeForResume();
	assert.equal((await resumed.run()).status, "needs_attention");
	assert.equal(mock.spawned.length, before);
	assert.equal((await readLatestV3Attempt(launched.runDir, "b"))?.attempt, 1);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("downstream retries consume immutable Attempt artifacts instead of the mutable alias", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.behaviors.set("ARTIFACT_A", (input) => completeChild({ ...input, output: "immutable-output" }));
	mock.behaviors.set("ARTIFACT_B", (input) => completeChild({ ...input, output: "consumer-output" }));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "immutable artifact handoff",
		nodes: [
			{ taskId: "a", agent: "test-agent", task: "ARTIFACT_A", sideEffect: "local_read", outputArtifact: "result.txt" },
			{ taskId: "b", agent: "test-agent", task: "ARTIFACT_B", dependsOn: ["a"], sideEffect: "local_read", inputArtifacts: ["result.txt"] },
		],
	};
	const launched = await launch(sandboxInfo, spec, mock, { preflightAgent: async () => undefined });
	await writeFile(join(launched.runDir, "artifacts", "a.txt"), "mutable-alias-tamper", "utf8");
	const resumed = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: launched.runDir, graph: launched.graph,
		authorization: launched.init.authorization, sourceCwd: sandboxInfo.sourceDir,
		sessionId: "session-test", supervisorEpoch: "epoch-2", retryBaselines: { b: 1 },
		preflightAgent: async () => undefined,
	});
	await resumed.initializeForResume();
	assert.equal((await resumed.run()).status, "complete");
	const workspace = await readV3WorkspaceEvidence(launched.runDir, "b", 2);
	assert.equal(workspace?.inputBaseline["result.txt"]?.sourcePath, join(launched.runDir, "artifacts", "a", "attempt-1.txt"));
	assert.equal(await readFile(join(launched.runDir, "artifacts", "a", "attempt-1.txt"), "utf8"), "immutable-output");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(sandboxInfo.sandbox, { recursive: true, force: true }));
});

test("v3StopChild does not treat paused as confirmed termination", async () => {
	const mock = new MockSubagents();
	mock.stopBehavior = "ignore";
	mock.behaviors.set("PAUSED_STOP", (input) => pauseChild(input));
	mock.start();
	const rpc = new SubagentRpcClient(mock);
	const binding = await v3DispatchChild(rpc, {
		agent: "test-agent", task: "PAUSED_STOP", cwd: process.cwd(), sessionDir: "", agentScope: "project",
	});
	await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
	await assert.rejects(v3StopChild(rpc, binding, { timeoutMs: 150 }), /could not be confirmed/u);
	await mock.dispose();
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

test("V3 runner requestStop aborts in-flight nodes and leaves blocked dependents Attempt-free", async () => {
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
 // This test promises an in-flight child; a fixed delay races initialization on busy hosts.
 const readyDeadline=Date.now()+10_000;
 let runningEvidence=await readLatestV3Attempt(sandboxInfo.runDir,"slow");
 while(runningEvidence?.evidence.phase!=="running" && Date.now()<readyDeadline) {
  await new Promise(resolvePromise=>setTimeout(resolvePromise,20));
  runningEvidence=await readLatestV3Attempt(sandboxInfo.runDir,"slow");
 }
 assert.equal(runningEvidence?.evidence.phase,"running","stop fixture must observe durable running identity before requesting stop");

	runner.requestStop();
	const snapshot = await runPromise;
	assert.equal(snapshot.status, "stopped");
	const slow = await readLatestV3Attempt(sandboxInfo.runDir, "slow");
	assert.equal(slow!.evidence.phase, "aborted");
	const later = await readLatestV3Attempt(sandboxInfo.runDir, "later");
	assert.equal(snapshot.nodes?.later?.phase, "blocked");
	assert.equal(later, undefined, "a dependency-blocked node must not fabricate an Attempt");
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

test("V3 rejects a new timed node before any dispatch", () => {
 assert.throws(() => compileGraphSpecV3({schemaVersion:3,goal:"unlimited",nodes:[{taskId:"deadline",agent:"test-agent",task:"test",sideEffect:"local_read",timeoutMs:750}]}), /remove timeoutMs/);
});

test("V3 runner requestStop uses the configured child-stop confirmation timeout", async () => {
	const sandboxInfo = await setupRun();
	const mock = new MockSubagents();
	mock.stopBehavior = "ignore";
	mock.behaviors.set("STOP_TIMEOUT", () => new Promise<void>(() => undefined));
	mock.start();
	const spec: GraphSpecV3 = {
		schemaVersion: 3,
		goal: "bounded stop confirmation",
		nodes: [{ taskId: "stubborn", agent: "test-agent", task: "STOP_TIMEOUT", sideEffect: "local_read" }],
	};
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: resolve(sandboxInfo.runsDir), runDir: sandboxInfo.runDir, graph, sessionId: "session-test", supervisorEpoch: "epoch-1", sourceCwd: sandboxInfo.sourceDir, runInstanceId: sandboxInfo.runInstanceId });
	const runner = new V3GraphRunner({
		rpc,
		runDir: sandboxInfo.runDir,
		graph,
		authorization: init.authorization,
		sourceCwd: sandboxInfo.sourceDir,
		sessionId: "session-test",
		supervisorEpoch: "epoch-1",
		childStopTimeoutMs: 150,
		preflightAgent: async () => undefined,
	});
	const runPromise = runner.run();
	let running = false;
	for (let index = 0; index < 300; index += 1) {
		const latest = await readLatestV3Attempt(sandboxInfo.runDir, "stubborn");
		if (latest?.evidence.phase === "running") {
			running = true;
			break;
		}
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	assert.equal(running, true, "the child must be running before requestStop exercises its stop path");
	const stopStartedAt = Date.now();
	runner.requestStop();
	const snapshot = await runPromise;
	const elapsedMs = Date.now() - stopStartedAt;
	assert.equal(snapshot.status, "needs_attention");
	assert.ok(elapsedMs < 2_000, `configured 150ms stop timeout must not fall back to 30s (elapsed ${elapsedMs}ms)`);
	const attempt = (await readLatestV3Attempt(sandboxInfo.runDir, "stubborn"))!.evidence;
	assert.equal(attempt.phase, "needs_attention");
	assert.equal(attempt.failure?.kind, "dispatch_unknown");
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

for (const sideEffect of ["local_read", "local_write"] as const) test(`confirmed crash ${sideEffect}: native evidence does not auto-repeat and independent branch proceeds`, async()=>{
 const f=await setupRun();const mock=new MockSubagents();let attempts=0;
 mock.behaviors.set("CRASH_BRANCH",async input=>{attempts++;await writeFile(join(input.asyncDir,"status.json"),JSON.stringify({runId:input.asyncId,state:"failed"}));await publishMockTerminal(input,true);});
 mock.behaviors.set("HEALTHY_BRANCH",input=>completeChild({...input,output:"independent done"}));mock.start();
 try {
  const result=await launch(f,{schemaVersion:3,goal:"isolated runtime failure",maxConcurrency:1,nodes:[
   {taskId:"crash",agent:"test-agent",task:"CRASH_BRANCH",sideEffect,...(sideEffect==="local_write"?{writeScope:[{kind:"file" as const,path:"out.txt"}],validationCommands:["test -f out.txt"]}:{})},
   {taskId:"healthy",agent:"test-agent",task:"HEALTHY_BRANCH",sideEffect:"local_read"},
   {taskId:"dependent",agent:"test-agent",task:"MUST_NOT_RUN",dependsOn:["crash"],sideEffect:"local_read"},
  ]},mock,{preflightAgent:async()=>{}});
  assert.equal(result.snapshot.status,"needs_attention");assert.equal(attempts,1);
  assert.equal((await readLatestV3Attempt(result.runDir,"healthy"))?.evidence.phase,"accepted");
  assert.equal(await readLatestV3Attempt(result.runDir,"dependent"),undefined);
 } finally {await mock.dispose();await import("node:fs/promises").then(fs=>fs.rm(f.sandbox,{recursive:true,force:true}));}
});

for (const status of ["blocked", "fail", "invalid"]) {
 test(`typed business ${status} finishes without launching accepted-only dependent`, async () => {
  const info = await setupRun(); const mock = new MockSubagents();
  mock.behaviors.set("TYPED_REVIEW", input => completeChild({...input, output: status === "invalid" ? "PASS" : JSON.stringify({status,reason:"Missing required proof"})}));
  mock.behaviors.set("ARCHIVE_NODE", input => completeChild(input)); mock.start();
  try {
   const {snapshot,runDir} = await launch(info, {schemaVersion:3,goal:"typed gate",nodes:[
    {taskId:"review",agent:"test-agent",task:"TYPED_REVIEW",sideEffect:"none",resultContract:"status-json"},
    {taskId:"archive",agent:"test-agent",task:"ARCHIVE_NODE",dependsOn:["review"],sideEffect:"none"}
   ]},mock,{preflightAgent:async()=>{}});
   assert.equal(snapshot.status,"failed"); assert.equal(mock.spawned.length,1);
   assert.equal((await readLatestV3Attempt(runDir,"review"))?.evidence.phase,"failed");
  } finally {await mock.dispose();}
 });
}

test("declared evidence survives cleanup, is delivered byte-for-byte, excludes secrets and detects tampering", async () => {
 const {lstat} = await import("node:fs/promises");
 const info = await setupRun(); const mock = new MockSubagents(); let producerCwd = "";
 mock.behaviors.set("PRODUCE_EVIDENCE", async input => {
  producerCwd=input.cwd;
  await writeFile(join(input.cwd,"screen.png"), Buffer.from([137,80,78,71,0,255]));
  await writeFile(join(input.cwd,"credentials.txt"),"never retain this secret");
  await completeChild({...input,output:JSON.stringify({status:"pass",reason:"Proof recorded"})});
 });
 mock.behaviors.set("CONSUME_EVIDENCE", async input => {
  assert.deepEqual(await readFile(join(input.cwd,".pi-graph/inputs/proof.files/screen.png")),Buffer.from([137,80,78,71,0,255]));
  await assert.rejects(readFile(join(input.cwd,".pi-graph/inputs/proof.files/credentials.txt")));
  await completeChild(input);
 });mock.start();
 try {
  const {snapshot,runDir} = await launch(info,{schemaVersion:3,permissionPolicy:"inherited",parentToolAllowlist:["read","write","bash"],goal:"durable evidence",nodes:[
   {taskId:"producer",agent:"test-agent",task:"PRODUCE_EVIDENCE",sideEffect:"external_write",outputArtifact:"proof",resultContract:"status-json",evidenceFiles:[{path:"screen.png",nonSecret:true}]},
   {taskId:"consumer",agent:"test-agent",task:"CONSUME_EVIDENCE",sideEffect:"none",dependsOn:["producer"],inputArtifacts:["proof"]}
  ]},mock,{preflightAgent:async()=>{}});
  assert.equal(snapshot.status,"complete"); assert.equal(mock.spawned.length,2);
  await assert.rejects(lstat(producerCwd));
  const directory=join(runDir,"artifacts/producer/attempt-1-files");
  await assert.rejects(readFile(join(directory,"files/credentials.txt")));
  const attempt=(await readLatestV3Attempt(runDir,"producer"))!.evidence;
  assert.ok(attempt.evidenceManifestDigest);
  assert.equal((await verifyV3AcceptedAttemptChain(runDir,"producer",1)).ok,true);
  await writeFile(join(directory,"files/screen.png"),"tampered");
  const chain=await verifyV3AcceptedAttemptChain(runDir,"producer",1);
  assert.equal(chain.ok,false);assert.match(chain.reasons.join(" "),/INVALID_EVIDENCE_FILES/);
 } finally {await mock.dispose();}
});


test("runner drains an already started heartbeat before releasing its lease", async () => {
 const f=await setupRun();const mock=new MockSubagents();
 const {acquireV3RunLease}=await import("../src/v3/lease.ts");
 let entered!:()=>void,unblock!:()=>void;
 const refreshing=new Promise<void>(r=>{entered=r;});
 const gate=new Promise<void>(r=>{unblock=r;});
 mock.behaviors.set("HEARTBEAT_DRAIN",async input=>{await refreshing;await completeChild({...input,output:"done"});});mock.start();
 const graph=compileGraphSpecV3({schemaVersion:3,goal:"heartbeat drain",nodes:[{taskId:"work",agent:"test-agent",task:"HEARTBEAT_DRAIN",sideEffect:"local_read"}]});
 const init=await initializeV3Run({trustedRoot:resolve(f.runsDir),runDir:f.runDir,graph,sessionId:"session-test",supervisorEpoch:"epoch-1",sourceCwd:f.sourceDir,runInstanceId:f.runInstanceId});
 const lease=await acquireV3RunLease(join(f.runDir,"lease.json"),f.runInstanceId);
 let releaseCalled=false,settled=false;
 const runner=new V3GraphRunner({rpc:new SubagentRpcClient(mock),runDir:f.runDir,graph,authorization:init.authorization,sourceCwd:f.sourceDir,sessionId:"session-test",supervisorEpoch:"epoch-1",preflightAgent:async()=>undefined,lease:{...lease,refresh:async()=>{entered();await gate;await lease.refresh();},release:async()=>{releaseCalled=true;await lease.release();}}});
 try {
  const running=runner.run().then(value=>{settled=true;return value;});
  await refreshing;
  // Allow the child to finish and the runner to reach its final cleanup.
  await new Promise(r=>setTimeout(r,250));
  assert.equal(releaseCalled,false,"lease release must wait for refresh completion");
  assert.equal(settled,false,"run must not return with outstanding lease work");
  unblock();assert.equal((await running).status,"complete");assert.equal(releaseCalled,true);
  const {lstat}=await import("node:fs/promises");
  await assert.rejects(lstat(join(f.runDir,"lease.json.gate")),{code:"ENOENT"});
 } finally {unblock();await mock.dispose();await import("node:fs/promises").then(fs=>fs.rm(f.sandbox,{recursive:true,force:true}));}
});
