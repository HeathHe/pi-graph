import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraph } from "../src/compile.ts";
import { assertRedispatchAllowed, GraphManager, legacySessionIdentity, loadValidatedGraph, sessionIdentity, waitingInputResumeAction } from "../src/manager.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { GraphRunner, initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import type { GraphConfig, GraphSpec } from "../src/types.ts";
import { loadValidatedRun } from "../src/reconciler.ts";

class ControllableBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	started = false;
	private asyncDir?: string;
	private asyncId?: string;
	on(channel: string, handler: (data: unknown) => void) { const set = this.handlers.get(channel) ?? new Set(); set.add(handler); this.handlers.set(channel, set); return () => set.delete(handler); }
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "spawn") {
			this.asyncId = `pi-graph-manager-control-${request.requestId}`;
			this.asyncDir = join(subagentAsyncRoot(), this.asyncId);
			void (async () => {
				await mkdir(this.asyncDir!, { recursive: true });
				await writeFile(join(this.asyncDir!, "status.json"), JSON.stringify({ runId: this.asyncId, state: "running", sessionId: "session", sessionDir: request.params.sessionDir }));
				this.started = true;
				this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { details: { asyncId: this.asyncId, asyncDir: this.asyncDir } } });
			})();
		}
			if (request.method === "stop") {
				void (async () => {
					const asyncId = String(request.params.id ?? this.asyncId);
					const asyncDir = this.asyncDir ?? join(subagentAsyncRoot(), asyncId);
					await mkdir(asyncDir, { recursive: true });
					await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "stopped", sessionId: "session" }));
					this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { state: "stopping" } });
				})();
		}
	}
}

class CompletingBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	spawns = 0;
	stopCalls = 0;
	on(channel: string, handler: (data: unknown) => void) {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => set.delete(handler);
	}
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "stop") {
			this.stopCalls += 1;
			return;
		}
		if (request.method !== "spawn") return;
		this.spawns += 1;
		const asyncId = `manager-complete-${request.requestId.slice(-24)}`;
		const asyncDir = join(subagentAsyncRoot(), asyncId);
		void (async () => {
			await mkdir(asyncDir, { recursive: true });
			const status = { runId: asyncId, state: "running", sessionId: "session-id", sessionDir: join(request.params.sessionDir as string, "child") };
			await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId, asyncDir } } });
			await mkdir(join(request.params.output as string, ".."), { recursive: true });
			await writeFile(request.params.output as string, "accepted output");
			const outputLog = join(asyncDir, "output.log");
			await writeFile(outputLog, "accepted output");
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({ ...status, state: "complete", outputFile: outputLog }));
			this.emit("subagent:async-complete", { runId: asyncId, asyncDir });
		})();
	}
}

function managerFor(bus: EventBus, config: GraphConfig, cwd: string): GraphManager {
	const manager = new GraphManager({ events: bus, sendMessage() {}, } as any);
	Object.assign(manager as any, {
		config,
		context: { cwd, sessionManager: { getSessionFile: () => "session", getSessionId: () => "session-id" }, ui: { notify() {} } },
	});
	return manager;
}

test("paused children must be resumed or stopped instead of duplicated", () => {
	assert.throws(() => waitingInputResumeAction("paused", "pause"), /still paused/);
	assert.equal(waitingInputResumeAction("running"), "monitor");
	assert.equal(waitingInputResumeAction("complete"), "monitor");
	assert.throws(() => waitingInputResumeAction(undefined), /will not replace/);
	assert.throws(() => waitingInputResumeAction("stopped"), /will not replace/);
});

test("current and legacy Pi session identities remain distinct during migration", () => {
	const context = { sessionManager: { getSessionId: () => "session-id", getSessionFile: () => "/tmp/session.jsonl" } } as any;
	assert.equal(sessionIdentity(context), "session-id");
	assert.equal(legacySessionIdentity(context), "/tmp/session.jsonl");
});

test("new graphs bind to Pi's session id instead of the session file path", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-session-id-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 20,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		runtimeV2Dispatch: false,
	};
	const manager = managerFor(new ControllableBus(), config, cwd);
	const snapshot = await manager.start({
		schemaVersion: 1,
		graphId: "session-identity",
		goal: "identity",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	});
	assert.equal(snapshot.sessionId, "session-id");
	await manager.suspendAll();
});

test("runner persists needs_attention before releasing its Supervisor after an internal failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-failure-state-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "runtime-failure-state",
		goal: "failure state",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	(store as any).readDesiredState = async () => { throw new Error("control plane read failed"); };
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	await assert.rejects(new GraphRunner(graph, snapshot, store, new ControllableBus(), new LeaseRegistry(join(runs, ".control", "leases")), config).run(), /control plane read failed/);
	const persisted = await new GraphStore(runs, graph.graphId).loadSnapshot();
	assert.equal(persisted.status, "needs_attention");
	assert.match(persisted.error ?? "", /control plane read failed/);
});

test("manual resume cannot bypass retry budget or non-idempotent writes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-"));
	const graph = compileGraph({ schemaVersion: 1, goal: "resume", nodes: [
		{ taskId: "safe", agent: "worker", task: "safe", outputArtifact: "safe.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
		{ taskId: "unsafe", agent: "worker", task: "unsafe", outputArtifact: "unsafe.md", sideEffect: "external_write", idempotent: false },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd);
	snapshot.nodes.safe!.attempt = 1;
	assert.doesNotThrow(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!));
	snapshot.nodes.safe!.attempt = 2;
	assert.throws(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!), /exhausted/);
	assert.throws(() => assertRedispatchAllowed(graph.nodes[1]!, snapshot.nodes.unsafe!), /external write authority/);
	snapshot.nodes.safe!.attempt = 1;
	graph.nodes[0]!.retryPolicy.retryOn = ["failed"];
	assert.throws(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!, "dispatch"), /not authorized by retryOn/);
});

test("recovery recompiles persisted graphs and rejects path tampering", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-manager-recovery-"));
	const runs = join(root, "runs");
	const graph = compileGraph({ schemaVersion: 1, graphId: "tampered", goal: "recover", nodes: [
		{ taskId: "safe", agent: "worker", task: "safe", outputArtifact: "safe.md", sideEffect: "none" },
	] } as GraphSpec, root);
	const snapshot = initialSnapshot(graph, root);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	await writeFile(store.path("graph.json"), JSON.stringify({ ...graph, nodes: [{ ...graph.nodes[0], outputArtifact: "../../../escape.md" }] }));
	await assert.rejects(() => loadValidatedGraph(store, snapshot, 20), /outputArtifact/);
});

test("an offline manager sends stop control to the active Supervisor", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "controlled-stop", goal: "stop", workspace: "shadow", nodes: [
		{ taskId: "running", agent: "worker", task: "keep running", outputArtifact: "running.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new ControllableBus();
	const runner = new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), config);
	const running = runner.run();
	while (!bus.started) await new Promise((resolve) => setTimeout(resolve, 5));
	const stopped = await managerFor(bus, config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped");
	assert.equal((await running).status, "stopped");
	assert.equal((await store.loadSnapshot()).status, "stopped");
});

test("stop preserves stale attention and terminal graph states", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-terminal-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "terminal-stop", goal: "terminal", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.status = "needs_attention";
	const attemptRoot = join(runs, graph.graphId, "nodes", "node", "attempt-1");
	snapshot.nodes.node = { taskId: "node", status: "stale", attempt: 1, attempts: [{ attempt: 1, status: "stale", sessionDir: join(attemptRoot, "session") }] };
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const manager = managerFor(new ControllableBus(), config, cwd);
	assert.equal((await manager.stop(graph.graphId)).status, "needs_attention");
	const persisted = await store.loadSnapshot();
	persisted.status = "complete";
	persisted.nodes.node!.status = "accepted";
	persisted.nodes.node!.attempts[0]!.status = "accepted";
	await store.saveSnapshot(persisted);
	assert.equal((await manager.stop(graph.graphId)).status, "complete");
});

test("offline v2 stop commits terminal attempt authority before saving its snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-v2-offline-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 1_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-offline-stop",
		goal: "stop",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	} as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	const asyncId = `pi-graph-manager-resource-wait-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "session-id" }));
	snapshot.status = "needs_attention";
	snapshot.nodes.read = {
		taskId: "read",
		status: "resource_wait",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "running",
			sessionDir: join(attemptRoot, "session"),
			workspaceKind: "shadow",
			asyncId,
			asyncDir,
		}],
	};
	await store.saveSnapshot(snapshot);
	const base = {
		schemaVersion: 2 as const,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: snapshot.supervisorEpoch,
		fencingGeneration: snapshot.fencingGeneration,
		updatedAt: new Date().toISOString(),
	};
	await store.writeAttemptRecord("read", 1, { ...base, phase: "prepared" });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", asyncId });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "running", asyncId });
	await store.writeWorkspaceRecord("read", 1, {
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		workspaceKind: "shadow",
		contractDigest: "0".repeat(64),
		writeBaseline: {},
		readBaseline: {},
		inputBaseline: {},
		createdAt: new Date().toISOString(),
	});
	const stopped = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped");
	assert.equal(stopped.nodes.read?.status, "stopped");
	assert.equal((await store.readAttemptRecord("read", 1)).terminalStatus, "stopped");
	assert.equal((await loadValidatedRun(store, 2)).snapshot.status, "stopped");
});

test("offline stop validates and preserves accepted authority ahead of a needs-attention snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-v2-offline-accepted-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 1_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-offline-accepted",
		goal: "accepted stop",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	} as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new CompletingBus();
	const complete = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run();
	const recoveryStore = new GraphStore(runs, graph.graphId);
	complete.status = "needs_attention";
	complete.nodes.read!.status = "verifying";
	complete.nodes.read!.attempts[0]!.status = "verifying";
	await recoveryStore.saveSnapshot(complete);
	assert.equal((await loadValidatedRun(recoveryStore, 2)).snapshot.status, "needs_attention");
	const stopped = await managerFor(bus, config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "complete");
	assert.equal(stopped.nodes.read?.status, "accepted");
	assert.equal((await recoveryStore.readAttemptRecord("read", 1)).phase, "accepted");
	assert.equal(bus.stopCalls, 0);
	assert.equal((await loadValidatedRun(recoveryStore, 2)).snapshot.status, "complete");
	const asyncDir = stopped.nodes.read?.attempts[0]?.asyncDir;
	if (asyncDir) {
		assert.equal(JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")).state, "complete");
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("offline stop preserves an interrupted apply as recoverable attention", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-applying-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "after\n");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "applying-stop", goal: "apply", workspace: "shadow", nodes: [{
		taskId: "write", agent: "worker", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "write", "attempt-1");
	await mkdir(join(attemptRoot, "session"), { recursive: true });
	snapshot.status = "running";
	snapshot.nodes.write = { taskId: "write", status: "verifying", attempt: 1, attempts: [{ attempt: 1, status: "verifying", sessionDir: join(attemptRoot, "session"), workspaceDir: join(attemptRoot, "workspace"), workspaceKind: "shadow", outputPath: join(attemptRoot, "output", "result.md") }] };
	await store.saveSnapshot(snapshot);
	await writeFile(join(attemptRoot, "apply-plan.json"), JSON.stringify({ version: 1, status: "applying", applyingIndex: 0, entries: [{ sourcePath: join(cwd, "target.md"), before: "a".repeat(64), after: "b".repeat(64) }] }));
	const result = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.nodes.write?.status, "stale");
	assert.match(result.nodes.write?.error ?? "", /Durable stop could not recover source apply/);
});

test("offline stop reloads state after acquiring the Supervisor claim", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-stop-race-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "stop-race", goal: "race", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.status = "running";
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const original = GraphStore.prototype.acquireSupervisor;
	GraphStore.prototype.acquireSupervisor = async function (epoch: string) {
		const releaseInjection = await original.call(this, `state-change-${epoch}`);
		const latest = await this.loadSnapshot();
		latest.status = "blocked";
		latest.nodes.node!.status = "blocked";
		await this.saveSnapshot(latest);
		await releaseInjection();
		return original.call(this, epoch);
	};
	try {
		const result = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
		assert.equal(result.status, "blocked");
		assert.equal((await store.loadSnapshot()).status, "blocked");
	} finally {
		GraphStore.prototype.acquireSupervisor = original;
	}
});

test("manual resume cannot replace a missing child from a stale attempt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-missing-child-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "missing-child", goal: "resume", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	const asyncId = "missing-child-run";
	snapshot.status = "needs_attention";
	snapshot.nodes.node = { taskId: "node", status: "stale", attempt: 1, attempts: [{ attempt: 1, status: "stale", sessionDir: join(attemptRoot, "session"), asyncId, asyncDir: join(subagentAsyncRoot(), asyncId) }] };
	await store.saveSnapshot(snapshot);
	await assert.rejects(() => managerFor(new ControllableBus(), config, cwd).resume(graph.graphId), /will not replace/);
	const persisted = await store.loadSnapshot();
	assert.equal(persisted.nodes.node?.status, "stale");
	assert.equal(persisted.nodes.node?.attempt, 1);
});
