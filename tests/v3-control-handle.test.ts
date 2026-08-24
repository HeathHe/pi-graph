import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	V3ControlRevisionConflictError,
	initializeV3RunControl,
	readV3RunControl,
	updateV3RunControl,
} from "../src/v3/control.ts";
import { readLatestV3Attempt } from "../src/v3/attempt.ts";
import { V3GraphHost, V3GraphRunHandle } from "../src/v3/host.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

async function controlFixture(): Promise<{ root: string; runDir: string }> {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-control-")));
	const runDir = join(root, "run");
	await mkdir(runDir);
	return { root, runDir };
}

test("V3 control persists a monotonic desired-state revision and rejects stale CAS", async () => {
	const { root, runDir } = await controlFixture();
	try {
		const initial = await initializeV3RunControl(runDir, "run-1", "graph-1");
		assert.equal(initial.desiredState, "running");
		assert.equal(initial.revision, 0);
		assert.deepEqual(JSON.parse(await readFile(join(runDir, "control.json"), "utf8")), initial);

		const paused = await updateV3RunControl(runDir, "paused", {
			expectedRevision: 0,
			runInstanceId: "run-1",
			graphId: "graph-1",
		});
		assert.equal(paused.desiredState, "paused");
		assert.equal(paused.revision, 1);

		await assert.rejects(
			updateV3RunControl(runDir, "stopped", { expectedRevision: 0 }),
			(error: unknown) => error instanceof V3ControlRevisionConflictError
				&& error.expectedRevision === 0
				&& error.actualRevision === 1,
		);
		assert.deepEqual(await readV3RunControl(runDir), paused, "a failed CAS must not change durable intent");

		const resumed = await updateV3RunControl(runDir, "running", { expectedRevision: 1 });
		assert.equal(resumed.revision, 2);
		assert.equal(resumed.desiredState, "running");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 control serializes concurrent CAS so exactly one writer commits a revision", async () => {
	const { root, runDir } = await controlFixture();
	try {
		await initializeV3RunControl(runDir, "run-race", "graph-race");
		const results = await Promise.allSettled([
			updateV3RunControl(runDir, "paused", { expectedRevision: 0 }),
			updateV3RunControl(runDir, "stopped", { expectedRevision: 0 }),
		]);
		assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
		const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
		assert.ok(rejected?.reason instanceof V3ControlRevisionConflictError);
		const persisted = await readV3RunControl(runDir);
		assert.equal(persisted.revision, 1);
		assert.ok(persisted.desiredState === "paused" || persisted.desiredState === "stopped");
		await assert.rejects(readFile(join(runDir, "control.json.lock"), "utf8"), { code: "ENOENT" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("V3 start returns a live RunHandle before terminal and its commands are durable", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-handle-")));
	const sourceDir = join(root, "source");
	const runsDir = join(root, "runs");
	await mkdir(sourceDir);
	await mkdir(runsDir);
	const mock = new MockSubagents();
	mock.behaviors.set("HANG", () => new Promise<void>(() => undefined));
	mock.start();
	try {
		const host = new V3GraphHost({
			rpc: new SubagentRpcClient(mock),
			runsDir,
			sessionId: "session-handle",
			supervisorEpoch: "epoch-handle",
			preflightAgent: async () => undefined,
		});
		const spec: GraphSpecV3 = {
			schemaVersion: 3,
			graphId: "async-handle",
			goal: "return before the child finishes",
			nodes: [{ taskId: "slow", agent: "test-agent", task: "HANG", sideEffect: "local_read" }],
		};
		const handle = await host.start(spec, sourceDir);
		assert.ok(handle instanceof V3GraphRunHandle);
		assert.equal(handle.graphId, "async-handle");
		assert.equal(handle.runDir, join(runsDir, "async-handle"));
		assert.ok(["queued", "running"].includes((await handle.status()).status), "start must return before terminal completion");

		const initial = await handle.control();
		assert.equal(initial.desiredState, "running");
		assert.equal(initial.revision, 0);
		const paused = await handle.pause({ expectedRevision: 0 });
		assert.equal(paused.desiredState, "paused");
		assert.equal(paused.revision, 1);
		const resumed = await handle.resume({ expectedRevision: 1 });
		assert.equal(resumed.desiredState, "running");
		assert.equal(resumed.revision, 2);
		const stopped = await handle.stop({ expectedRevision: 2 });
		assert.equal(stopped.desiredState, "stopped");
		assert.equal(stopped.revision, 3);
		assert.deepEqual(await readV3RunControl(handle.runDir), stopped);
		assert.equal((await handle.wait()).status, "stopped");

		const reopened = await host.openHandle(handle.graphId);
		assert.ok(reopened instanceof V3GraphRunHandle);
		assert.equal((await reopened.control()).revision, 3);
		assert.equal((await reopened.status()).status, "stopped");
	} finally {
		await mock.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("RunHandle resume commits running intent and starts a real background runner", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-handle-resume-")));
	const sourceDir = join(root, "source");
	const runsDir = join(root, "runs");
	await mkdir(sourceDir);
	await mkdir(runsDir);
	const mock = new MockSubagents();
	mock.behaviors.set("FIRST", async (input) => {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 350));
		await completeChild({ ...input, output: "first" });
	});
	mock.behaviors.set("SECOND", (input) => completeChild({ ...input, output: "second" }));
	mock.start();
	try {
		const host = new V3GraphHost({
			rpc: new SubagentRpcClient(mock),
			runsDir,
			sessionId: "session-resume",
			supervisorEpoch: "epoch-resume",
			preflightAgent: async () => undefined,
		});
		const handle = await host.start({
			schemaVersion: 3,
			graphId: "pause-resume-handle",
			goal: "pause at a quiescent boundary and continue",
			nodes: [
				{ taskId: "first", agent: "test-agent", task: "FIRST", sideEffect: "local_read" },
				{ taskId: "second", agent: "test-agent", task: "SECOND", dependsOn: ["first"], sideEffect: "local_read" },
			],
		}, sourceDir);
		const deadline = Date.now() + 5_000;
		while (mock.spawned.length === 0 && Date.now() < deadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		assert.equal(mock.spawned.length, 1);
		const pausedIntent = await handle.pause({ expectedRevision: 0 });
		assert.equal(pausedIntent.revision, 1);
		const paused = await handle.wait();
		assert.equal(paused.status, "paused");
		assert.equal(mock.spawned.length, 1, "quiescent pause must not dispatch the dependent node");

		const runningIntent = await handle.resume({ expectedRevision: 1 });
		assert.equal(runningIntent.desiredState, "running");
		assert.equal(runningIntent.revision, 2);
		const terminal = await handle.wait();
		assert.equal(terminal.status, "complete");
		assert.equal(mock.spawned.length, 2);
	} finally {
		await mock.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("suspendAll durably pauses active runs and a fresh host does not auto-adopt them", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-suspend-all-")));
	const sourceDir = join(root, "source");
	const runsDir = join(root, "runs");
	await mkdir(sourceDir);
	await mkdir(runsDir);
	const mock = new MockSubagents();
	mock.behaviors.set("SUSPEND_FIRST", async (input) => {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
		await completeChild({ ...input, output: "first" });
	});
	mock.behaviors.set("SUSPEND_SECOND", (input) => completeChild({ ...input, output: "second" }));
	mock.start();
	const hostContext = {
		rpc: new SubagentRpcClient(mock),
		runsDir,
		sessionId: "session-suspend",
		supervisorEpoch: "epoch-suspend",
		preflightAgent: async () => undefined,
	};
	try {
		const host = new V3GraphHost(hostContext);
		const handle = await host.start({
			schemaVersion: 3,
			graphId: "suspend-all",
			goal: "persist shutdown pause before quiescing",
			nodes: [
				{ taskId: "first", agent: "test-agent", task: "SUSPEND_FIRST", sideEffect: "local_read" },
				{ taskId: "second", agent: "test-agent", task: "SUSPEND_SECOND", dependsOn: ["first"], sideEffect: "local_read" },
			],
		}, sourceDir);
		const spawnDeadline = Date.now() + 5_000;
		while (mock.spawned.length === 0 && Date.now() < spawnDeadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		assert.equal(mock.spawned.length, 1, "the run must be active before session suspension");

		const controls = await host.suspendAll();
		assert.equal(controls.length, 1);
		assert.equal(controls[0]!.desiredState, "paused");
		assert.equal(controls[0]!.revision, 1);
		assert.equal((await readV3RunControl(handle.runDir)).desiredState, "paused", "shutdown intent must be durable before returning");
		assert.equal((await handle.wait()).status, "paused");
		assert.equal(mock.spawned.length, 1, "session suspension must not dispatch downstream work");

		const freshHost = new V3GraphHost({ ...hostContext, sessionId: "session-fresh", supervisorEpoch: "epoch-fresh" });
		assert.deepEqual(await freshHost.adoptCrashedRuns(), [{ graphId: "suspend-all", outcome: "skipped" }]);
		assert.equal(mock.spawned.length, 1, "a durable paused run must remain quiescent after restart");
	} finally {
		await mock.dispose();
		await rm(root, { recursive: true, force: true });
	}
});

test("adoption leaves paused intent quiescent and honors an offline stopped intent", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "v3-control-adopt-")));
	const sourceDir = join(root, "source");
	const runsDir = join(root, "runs");
	await mkdir(sourceDir);
	await mkdir(runsDir);
	const mock = new MockSubagents();
	mock.behaviors.set("ADOPT_FIRST", async (input) => {
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
		await completeChild({ ...input, output: "first" });
	});
	mock.behaviors.set("ADOPT_SECOND", (input) => completeChild({ ...input, output: "second" }));
	mock.start();
	const hostContext = {
		rpc: new SubagentRpcClient(mock),
		runsDir,
		sessionId: "session-adopt",
		supervisorEpoch: "epoch-adopt",
		preflightAgent: async () => undefined,
	};
	try {
		const firstHost = new V3GraphHost(hostContext);
		const handle = await firstHost.start({
			schemaVersion: 3,
			graphId: "adopt-control",
			goal: "exercise offline control adoption",
			nodes: [
				{ taskId: "first", agent: "test-agent", task: "ADOPT_FIRST", sideEffect: "local_read" },
				{ taskId: "second", agent: "test-agent", task: "ADOPT_SECOND", dependsOn: ["first"], sideEffect: "local_read" },
			],
		}, sourceDir);
		const spawnDeadline = Date.now() + 5_000;
		while (mock.spawned.length === 0 && Date.now() < spawnDeadline) await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
		await handle.pause({ expectedRevision: 0 });
		assert.equal((await handle.wait()).status, "paused");

		const recoveringHost = new V3GraphHost({ ...hostContext, sessionId: "session-recover", supervisorEpoch: "epoch-recover" });
		assert.deepEqual(await recoveringHost.adoptCrashedRuns(), [{ graphId: "adopt-control", outcome: "skipped" }]);
		assert.equal(mock.spawned.length, 1, "paused adoption must not start a child");

		const stoppedIntent = await updateV3RunControl(handle.runDir, "stopped", { expectedRevision: 1 });
		assert.equal(stoppedIntent.revision, 2);
		assert.deepEqual(await recoveringHost.adoptCrashedRuns(), [{ graphId: "adopt-control", outcome: "resumed" }]);
		assert.equal((await recoveringHost.status("adopt-control")).status, "stopped");
		assert.equal((await readLatestV3Attempt(handle.runDir, "second"))?.evidence.phase, "aborted", "offline stop adoption must durably finalize queued nodes");
		assert.equal(mock.spawned.length, 1, "offline stop must abort queued work without dispatch");
	} finally {
		await mock.dispose();
		await rm(root, { recursive: true, force: true });
	}
});
