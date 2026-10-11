import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readLatestV3Attempt, v3RunPaths } from "../src/v3/attempt.ts";
import { V3GraphHost } from "../src/v3/host.ts";
import { acquireV3RunLease } from "../src/v3/lease.ts";
import { mutationCapabilityForLease } from "../src/v3/runner.ts";
import { commitV3RetryIntent, readV3RetryJournal } from "../src/v3/retry.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import type { GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild, failChild } from "./helpers/mock-subagents.ts";

async function fixture(
	onStateChange?: (snapshot: import("../src/v3/types.ts").GraphSnapshotV3) => void,
	onActiveWorkChange?: (items: readonly { id: string; sessionId: string }[]) => void,
	createHost?: (context: ConstructorParameters<typeof V3GraphHost>[0]) => V3GraphHost,
) {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-retry-host-")));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await Promise.all([mkdir(sourceDir, { recursive: true }), mkdir(runsDir, { recursive: true })]);
	const mock = new MockSubagents();
	mock.start();
	const context: ConstructorParameters<typeof V3GraphHost>[0] = {
		rpc: new SubagentRpcClient(mock),
		runsDir,
		sessionId: "retry-session",
		supervisorEpoch: "retry-epoch",
		preflightAgent: async () => undefined,
		...(onStateChange ? { onStateChange } : {}),
		...(onActiveWorkChange ? { onActiveWorkChange } : {}),
	};
	const host = createHost ? createHost(context) : new V3GraphHost(context);
	return { sandbox, sourceDir, runsDir, mock, host };
}

class GatedLoadV3GraphHost extends V3GraphHost {
	private nextLoadGate: { entered: () => void; released: Promise<void> } | undefined;

	gateNextLoad(): { entered: Promise<void>; release: () => void } {
		let markEntered!: () => void;
		let release!: () => void;
		const entered = new Promise<void>((resolveEntered) => { markEntered = resolveEntered; });
		const released = new Promise<void>((resolveReleased) => { release = resolveReleased; });
		this.nextLoadGate = { entered: markEntered, released };
		return { entered, release };
	}

	override async loadRun(runDir: string, graphId?: string) {
		const gate = this.nextLoadGate;
		if (gate) {
			this.nextLoadGate = undefined;
			gate.entered();
			await gate.released;
		}
		return super.loadRun(runDir, graphId);
	}
}

test("V3 Host forwards authoritative snapshot publications to its background-work notifier", async () => {
	const published: string[] = [];
	const f = await fixture((snapshot) => published.push(snapshot.status));
	try {
		f.mock.behaviors.set("RUN_ROOT", (input) => completeChild({ ...input, output: "root output" }));
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("state-notifier"), f.sourceDir);
		await f.host.waitForCompletion(handle.graphId);
		assert.ok(published.length > 0);
		assert.equal(published.at(-1), "complete");
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("V3 Host notifies background work only after active inventory changes", async () => {
	const inventories: Array<Array<{ id: string; sessionId: string }>> = [];
	const f = await fixture(undefined, (items) => inventories.push(items.map((item) => ({ ...item }))));
	try {
		f.mock.behaviors.set("RUN_ROOT", (input) => completeChild({ ...input, output: "root output" }));
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("active-work-notifier"), f.sourceDir);
		assert.deepEqual(inventories[0], [{ id: handle.graphId, sessionId: "retry-session" }]);
		await f.host.waitForCompletion(handle.graphId);
		assert.deepEqual(inventories.at(-1), [], "the terminal notification must run after Host removes the work item");
		assert.equal(inventories.length, 2, "node snapshots cannot create background-work wake churn");
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("V3 Host keeps one background-work identity across a pause-resume Supervisor handoff", { timeout: 15_000 }, async () => {
	const inventories: string[][] = [];
	let f!: Awaited<ReturnType<typeof fixture>>;
	let resumeRequested: Promise<unknown> | undefined;
	f = await fixture((snapshot) => {
		if (snapshot.graphId === "pause-resume-active-work" && snapshot.status === "paused" && !resumeRequested) {
			resumeRequested = f.host.requestDesiredState(snapshot.graphId, "running");
		}
	}, (items) => inventories.push(items.map((item) => item.id)));
	try {
		let releaseRoot!: () => void;
		const rootGate = new Promise<void>((resolveGate) => { releaseRoot = resolveGate; });
		f.mock.behaviors.set("RUN_ROOT", async (input) => {
			await rootGate;
			await completeChild({ ...input, output: "root output" });
		});
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("pause-resume-active-work"), f.sourceDir);
		while ((await readLatestV3Attempt(handle.runDir, "root"))?.evidence.phase !== "running") {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		const pausedPromise = f.host.pause(handle.graphId);
		releaseRoot();
		assert.equal((await pausedPromise).status, "paused");
		await resumeRequested;
		assert.equal((await f.host.waitForCompletion(handle.graphId)).status, "complete");
		await Promise.resolve();
		assert.deepEqual(inventories, [[handle.graphId], []], "the retiring and successor Supervisors must appear as one continuous job");
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("V3 Host reserves background work when pause overtakes an in-progress running request", { timeout: 15_000 }, async () => {
	const inventories: string[][] = [];
	const f = await fixture(
		undefined,
		(items) => inventories.push(items.map((item) => item.id)),
		(context) => new GatedLoadV3GraphHost(context),
	);
	const host = f.host as GatedLoadV3GraphHost;
	let releaseRoot: () => void = () => undefined;
	let releaseRunningLoad: () => void = () => undefined;
	let runningRequest: Promise<unknown> | undefined;
	let graphId: string | undefined;
	try {
		const rootGate = new Promise<void>((resolveGate) => { releaseRoot = resolveGate; });
		f.mock.behaviors.set("RUN_ROOT", async (input) => {
			await rootGate;
			await completeChild({ ...input, output: "root output" });
		});
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await host.start(chainSpec("pause-overtakes-running-active-work"), f.sourceDir);
		graphId = handle.graphId;
		while ((await readLatestV3Attempt(handle.runDir, "root"))?.evidence.phase !== "running") {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}

		const loadGate = host.gateNextLoad();
		releaseRunningLoad = loadGate.release;
		runningRequest = host.requestDesiredState(handle.graphId, "running");
		await loadGate.entered;

		const pausedPromise = host.pause(handle.graphId);
		releaseRoot();
		assert.equal((await pausedPromise).status, "paused");
		assert.deepEqual(host.listActiveWork(), [{ id: handle.graphId, sessionId: "retry-session" }]);
		assert.deepEqual(inventories, [[handle.graphId]], "the retiring Supervisor must remain visible while the earlier running request is blocked");

		releaseRunningLoad();
		await runningRequest;
		assert.equal((await host.waitForCompletion(handle.graphId)).status, "complete");
		await Promise.resolve();
		assert.deepEqual(inventories, [[handle.graphId], []], "the handoff must expose no false completion between Supervisors");
	} finally {
		releaseRoot();
		releaseRunningLoad();
		await runningRequest?.catch(() => undefined);
		if (graphId) await host.waitForCompletion(graphId).catch(() => undefined);
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("V3 Host attributes an adopted Graph to the current Pi session", { timeout: 15_000 }, async () => {
	const f = await fixture();
	try {
		let releaseRoot!: () => void;
		const rootGate = new Promise<void>((resolveGate) => { releaseRoot = resolveGate; });
		f.mock.behaviors.set("RUN_ROOT", async (input) => {
			await rootGate;
			await completeChild({ ...input, output: "root output" });
		});
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("new-session-active-work"), f.sourceDir);
		while ((await readLatestV3Attempt(handle.runDir, "root"))?.evidence.phase !== "running") {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		const pausedPromise = f.host.pause(handle.graphId);
		releaseRoot();
		assert.equal((await pausedPromise).status, "paused");

		let releaseTarget!: () => void;
		const targetGate = new Promise<void>((resolveGate) => { releaseTarget = resolveGate; });
		f.mock.behaviors.set("RUN_TARGET", async (input) => {
			await targetGate;
			await completeChild({ ...input, output: "target output" });
		});
		const inventories: Array<Array<{ id: string; sessionId: string }>> = [];
		let observeOwner!: () => void;
		const ownerObserved = new Promise<void>((resolveOwner) => { observeOwner = resolveOwner; });
		const adopted = new V3GraphHost({
			rpc: new SubagentRpcClient(f.mock),
			runsDir: f.runsDir,
			sessionId: "replacement-session",
			supervisorEpoch: "replacement-epoch",
			preflightAgent: async () => undefined,
			onActiveWorkChange: (items) => {
				inventories.push(items.map((item) => ({ ...item })));
				if (items.length > 0) observeOwner();
			},
		});
		const resumed = adopted.resume(handle.graphId);
		await ownerObserved;
		assert.deepEqual(adopted.listActiveWork(), [{ id: handle.graphId, sessionId: "replacement-session" }]);
		assert.deepEqual(inventories[0], [{ id: handle.graphId, sessionId: "replacement-session" }]);
		releaseTarget();
		assert.equal((await resumed).status, "complete");
		await Promise.resolve();
		assert.deepEqual(inventories.at(-1), []);
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

function chainSpec(graphId: string): GraphSpecV3 {
	return {
		schemaVersion: 3,
		graphId,
		goal: "retry one branch without replaying accepted upstream",
		nodes: [
			{ taskId: "root", agent: "test-agent", task: "RUN_ROOT", sideEffect: "none" },
			{ taskId: "target", agent: "test-agent", task: "RUN_TARGET", dependsOn: ["root"], sideEffect: "none" },
			{ taskId: "leaf", agent: "test-agent", task: "RUN_LEAF", dependsOn: ["target"], sideEffect: "none" },
		],
	};
}

test("V3 Host retry preserves accepted upstream and creates new Attempts for target and descendants", async () => {
	const f = await fixture();
	try {
		f.mock.behaviors.set("RUN_ROOT", (input) => completeChild({ ...input, output: "root output" }));
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("retry-chain"), f.sourceDir);
		assert.equal((await f.host.waitForCompletion(handle.graphId)).status, "complete");

		const acknowledged = await f.host.retry(handle.graphId, "target");
		assert.ok(["queued", "running", "complete"].includes(acknowledged.status));
		const retried = await f.host.waitForCompletion(handle.graphId);
		assert.equal(retried.status, "complete");
		assert.equal((await readLatestV3Attempt(handle.runDir, "root"))?.attempt, 1);
		assert.equal((await readLatestV3Attempt(handle.runDir, "target"))?.attempt, 2);
		assert.equal((await readLatestV3Attempt(handle.runDir, "leaf"))?.attempt, 2);
		assert.equal(f.mock.spawned.filter((entry) => String(entry.params.task).startsWith("RUN_ROOT")).length, 1);
		assert.equal(f.mock.spawned.filter((entry) => String(entry.params.task).startsWith("RUN_TARGET")).length, 2);
		assert.equal(f.mock.spawned.filter((entry) => String(entry.params.task).startsWith("RUN_LEAF")).length, 2);
		const journal = await readV3RetryJournal(handle.runDir, handle.graphId, handle.graphId);
		assert.deepEqual(journal.records[0]?.taskIds, ["target", "leaf"]);
		assert.deepEqual(journal.records[0]?.baselines, { target: 1, leaf: 1 });
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("a failed retry resets descendants to blocked and remains stable after Host restart", async () => {
	const f = await fixture();
	try {
		f.mock.behaviors.set("RETRY_A", (input) => completeChild({ ...input, output: "a-first" }));
		f.mock.behaviors.set("RETRY_B", (input) => completeChild({ ...input, output: "b-first" }));
		const spec: GraphSpecV3 = {
			schemaVersion: 3,
			graphId: "retry-failure-projection",
			goal: "failed retry blocks descendants",
			nodes: [
				{ taskId: "a", agent: "test-agent", task: "RETRY_A", sideEffect: "none" },
				{ taskId: "b", agent: "test-agent", task: "RETRY_B", dependsOn: ["a"], sideEffect: "none" },
			],
		};
		const handle = await f.host.start(spec, f.sourceDir);
		assert.equal((await f.host.waitForCompletion(handle.graphId)).status, "complete");
		f.mock.behaviors.set("RETRY_A", (input) => failChild(input));
		await f.host.retry(handle.graphId, "a");
		const failed = await f.host.waitForCompletion(handle.graphId);
		assert.equal(failed.status, "failed");
		assert.equal(failed.nodes?.a?.phase, "failed");
		assert.equal(failed.nodes?.a?.attempt, 2);
		assert.equal(failed.nodes?.b?.phase, "blocked");
		assert.equal(failed.nodes?.b?.attempt, 1, "the immutable historical Attempt remains visible behind the logical reset");
		assert.equal((await readLatestV3Attempt(handle.runDir, "b"))?.attempt, 1);

		const restarted = new V3GraphHost({
			rpc: new SubagentRpcClient(f.mock), runsDir: f.runsDir,
			sessionId: "retry-restart", supervisorEpoch: "retry-restart-epoch",
			preflightAgent: async () => undefined,
		});
		const projected = await restarted.status(handle.graphId);
		assert.equal(projected.status, "failed");
		assert.equal(projected.nodes?.a?.phase, "failed");
		assert.equal(projected.nodes?.b?.phase, "blocked");
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("a durable retry intent is adopted after a host crash without repeating already advanced Attempts", async () => {
	const f = await fixture();
	try {
		f.mock.behaviors.set("RUN_ROOT", (input) => completeChild({ ...input, output: "root output" }));
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("retry-adopt"), f.sourceDir);
		await f.host.waitForCompletion(handle.graphId);
		const loaded = await f.host.loadRun(handle.runDir, handle.graphId);
		const lease = await acquireV3RunLease(v3RunPaths(handle.runDir).leasePath, loaded.authorization.runInstanceId);
		try {
			await commitV3RetryIntent({
				runDir: handle.runDir,
				graph: loaded.graph,
				runInstanceId: loaded.authorization.runInstanceId,
				taskId: "target",
				capability: mutationCapabilityForLease(lease),
			});
		} finally {
			await lease.release();
		}

		const recovered = new V3GraphHost({
			rpc: new SubagentRpcClient(f.mock),
			runsDir: f.runsDir,
			sessionId: "recovery-session",
			supervisorEpoch: "recovery-epoch",
			preflightAgent: async () => undefined,
		});
		assert.deepEqual(await recovered.adoptCrashedRuns(), [{ graphId: handle.graphId, outcome: "resumed" }]);
		assert.equal((await recovered.waitForCompletion(handle.graphId)).status, "complete");
		assert.equal((await readLatestV3Attempt(handle.runDir, "root"))?.attempt, 1);
		assert.equal((await readLatestV3Attempt(handle.runDir, "target"))?.attempt, 2);
		assert.equal((await readLatestV3Attempt(handle.runDir, "leaf"))?.attempt, 2);
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("V3 Host pause commits durable intent and quiesces before dispatching downstream", async () => {
	const f = await fixture();
	try {
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
		f.mock.behaviors.set("RUN_ROOT", async (input) => {
			await gate;
			await completeChild({ ...input, output: "root output" });
		});
		f.mock.behaviors.set("RUN_TARGET", (input) => completeChild({ ...input, output: "target output" }));
		f.mock.behaviors.set("RUN_LEAF", (input) => completeChild({ ...input, output: "leaf output" }));
		const handle = await f.host.start(chainSpec("pause-chain"), f.sourceDir);
		while ((await readLatestV3Attempt(handle.runDir, "root"))?.evidence.phase !== "running") {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
		}
		const pausedPromise = f.host.pause(handle.graphId);
		release();
		const paused = await pausedPromise;
		assert.equal(paused.status, "paused");
		assert.equal(paused.nodes?.root?.phase, "accepted");
		assert.equal(paused.nodes?.target?.attempt, 0);
		assert.equal((await f.host.control(handle.graphId)).desiredState, "paused");
		assert.deepEqual(f.host.listActiveWork(), []);
		assert.equal((await f.host.resume(handle.graphId)).status, "complete");
	} finally {
		await f.mock.dispose();
		await rm(f.sandbox, { recursive: true, force: true });
	}
});

test("inherited retry rejects an already-dispatched external descendant without replaying any node", async () => {
 const f = await fixture();
 try {
  f.mock.behaviors.set("READ_ROOT", input => completeChild({ ...input, output: "read" }));
  f.mock.behaviors.set("WRITE_EXTERNAL", input => completeChild({ ...input, output: "external receipt" }));
  const spec: GraphSpecV3 = { schemaVersion: 3, graphId: "inherited-replay", goal: "Do not duplicate effects", permissionPolicy: "inherited", parentToolAllowlist: ["read", "bash"], nodes: [
   { taskId: "read", agent: "worker", task: "READ_ROOT", sideEffect: "external_read", readOnly: true },
   { taskId: "write", agent: "worker", task: "WRITE_EXTERNAL", sideEffect: "external_write", dependsOn: ["read"] },
  ] };
  const started = await f.host.start(spec, f.sourceDir);
  assert.equal((await f.host.waitForCompletion(started.graphId)).status, "complete");
  assert.equal(f.mock.spawned.length, 2);
  await assert.rejects(f.host.retry(started.graphId, "read"), /external effects/);
  assert.equal(f.mock.spawned.length, 2);
 } finally { await f.mock.dispose(); await rm(f.sandbox, { recursive: true, force: true }); }
});

test("inherited open Graph append/resume freezes original ceiling and intersects current runtime permissions", async () => {
 let currentTools = ["read", "bash"];
 const f = await fixture(undefined, undefined, context => new V3GraphHost({ ...context, parentToolAllowlist: () => currentTools }));
 try {
  f.mock.behaviors.set("CEILING_WORK", input => completeChild({ ...input, output: "done" }));
  const handle = await f.host.start({ schemaVersion: 3, graphId: "inherited-append", goal: "Frozen upper bound", mode: "open", permissionPolicy: "inherited", parentToolAllowlist: ["read", "bash"], toolFilter: ["read", "graph_mailbox"], nodes: [] }, f.sourceDir);
  assert.equal((await f.host.waitForCompletion(handle.graphId)).status, "idle");
  await f.host.pause(handle.graphId);
  currentTools = ["read", "write"];
  await f.host.append(handle.graphId, [{ taskId: "later", agent: "worker", task: "CEILING_WORK", sideEffect: "external_read", readOnly: true }], 0);
  await f.host.resume(handle.graphId);
  await f.host.waitForCompletion(handle.graphId);
  assert.equal(f.mock.spawned.length, 1);
  const ceiling = f.mock.spawned[0]!.params.capabilityCeiling as { allowedTools: string[] };
  assert.deepEqual(ceiling.allowedTools, ["read", "graph_mailbox"]);
  const loaded = await f.host.loadRun(handle.runDir, handle.graphId);
  assert.deepEqual(loaded.graph.nodes[0]!.parentToolAllowlist, ["read", "bash"]);
  assert.equal(loaded.graph.nodes[0]!.permissionPolicy, "inherited");
 } finally { await f.mock.dispose(); await rm(f.sandbox, { recursive: true, force: true }); }
});
