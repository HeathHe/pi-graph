import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileGraph } from "../src/compile.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { GraphRunner, initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import { subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { loadOrRebuildValidatedRun, loadValidatedRun } from "../src/reconciler.ts";
import { canonicalDigest } from "../src/authority.ts";
import { createPrunePlan, executePrunePlan, listTrashInventory, restoreTrash } from "../src/retention.ts";
import type { GraphConfig, GraphSpec } from "../src/types.ts";

class V2Subagents implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	spawns = 0;
	stopCalls = 0;
	complete = true;
	omitOutputCount = 0;
	rejectSpawnCount = 0;
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
			const asyncId = request.params.id as string;
			const asyncDir = join(subagentAsyncRoot(), asyncId);
			void (async () => {
				const status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8"));
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ ...status, state: "stopped" }));
				this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { state: "stopping" } });
			})();
			return;
		}
		if (request.method !== "spawn") return;
		this.spawns += 1;
		if (this.rejectSpawnCount > 0) {
			this.rejectSpawnCount -= 1;
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: false, error: { code: "INVALID_AGENT", message: "Unknown agent." } });
			return;
		}
		const asyncId = `v2-${request.requestId.slice(-24)}`;
		const asyncDir = join(subagentAsyncRoot(), asyncId);
		void (async () => {
			await mkdir(asyncDir, { recursive: true });
			const status = { runId: asyncId, state: "running", sessionId: "owner", sessionDir: join(request.params.sessionDir as string, "child") };
			await writeFile(join(asyncDir, "status.json"), JSON.stringify(status));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId, asyncDir } } });
			if (!this.complete) return;
			const omitOutput = this.omitOutputCount > 0;
			if (omitOutput) this.omitOutputCount -= 1;
			if (!omitOutput) {
				await mkdir(join(request.params.output as string, ".."), { recursive: true });
				await writeFile(request.params.output as string, "v2 output");
			}
			const outputLog = join(asyncDir, "output.log");
			await writeFile(outputLog, omitOutput ? "" : "v2 output");
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({ ...status, state: "complete", outputFile: outputLog }));
			this.emit("subagent:async-complete", { runId: asyncId, asyncDir });
		})();
	}
}

class FailRetryProjectionStore extends GraphStore {
	terminalWrites = 0;
	private failed = false;

	override async writeAttemptRecord(taskId: string, attempt: number, record: Parameters<GraphStore["writeAttemptRecord"]>[2]): Promise<string> {
		if (record.phase === "terminal") this.terminalWrites += 1;
		return super.writeAttemptRecord(taskId, attempt, record);
	}

	override async saveSnapshot(snapshot: Parameters<GraphStore["saveSnapshot"]>[0]): Promise<void> {
		if (!this.failed && Object.values(snapshot.nodes).some((node) => node.status === "retry_wait")) {
			this.failed = true;
			throw new Error("synthetic retry projection failure");
		}
		return super.saveSnapshot(snapshot);
	}
}

function config(runsDir: string): GraphConfig {
	return { enabled: true, runsDir, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 10, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
}

function spec(graphId: string): GraphSpec {
	return { schemaVersion: 1, graphId, goal: "v2 execution", workspace: "shadow", nodes: [{ taskId: "read", agent: "scout", task: "inspect", outputArtifact: "read.md", sideEffect: "local_read" }] };
}

test("result projection failure cannot rewrite immutable terminal authority", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-result-projection-"));
	const runs = join(cwd, "runs");
	const retrySpec = spec("v2-result-projection");
	retrySpec.nodes[0]!.retryPolicy = { maxAttempts: 2, backoffMs: 1, retryOn: ["failed"] };
	const graph = compileGraph(retrySpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new FailRetryProjectionStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.omitOutputCount = 1;
	await assert.rejects(
		new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run(),
		/synthetic retry projection failure/,
	);
	assert.equal(store.terminalWrites, 1);
	const authority = await store.readAttemptRecord("read", 1);
	assert.equal(authority.phase, "terminal");
	assert.equal(authority.terminalError, "Subagent completed without producing its declared output artifact.");
	const child = snapshot.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("parallel retries persist coherent node and attempt states", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-parallel-retry-"));
	const runs = join(cwd, "runs");
	const nodes = Array.from({ length: 6 }, (_, index) => ({
		taskId: `retry-${index}`,
		agent: "scout",
		task: `parallel retry ${index}`,
		outputArtifact: `retry-${index}.md`,
		sideEffect: "none" as const,
		retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["failed" as const] },
	}));
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-parallel-retry",
		goal: "Persist parallel retry transitions atomically.",
		workspace: "shadow",
		maxConcurrency: 6,
		nodes,
	}, cwd, 12, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.omitOutputCount = 6;
	const localConfig = { ...config(runs), maxConcurrency: 6, readOnlyBurst: 6, maxSpawnBudget: 12 };
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), localConfig).run();
	assert.equal(terminal.status, "complete");
	assert.equal(bus.spawns, 12);
	for (const state of Object.values(terminal.nodes)) {
		assert.deepEqual(state.attempts.map((attempt) => attempt.status), ["failed", "accepted"]);
	}
	assert.equal((await loadValidatedRun(store, 12)).snapshot.status, "complete");
	for (const state of Object.values(terminal.nodes)) {
		for (const attempt of state.attempts) {
			if (attempt.asyncDir) await rm(attempt.asyncDir, { recursive: true, force: true });
		}
	}
});

test("new v2 runtime executes through ChildRuntime and commits the complete evidence chain", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-run-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-success"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.status, "complete");
	assert.equal(bus.spawns, 1);
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	for (const name of ["attempt.json", "workspace.json", "validated-result.json", "result-manifest.json", "acceptance.json", "child-dispatch.json"]) {
		assert.doesNotReject(readFile(join(attemptRoot, name), "utf8"));
	}
	assert.equal((await loadValidatedRun(store, 10)).snapshot.status, "complete");
	await writeFile(store.path("snapshot.json"), "{corrupt");
	const rebuildStore = new GraphStore(runs, graph.graphId);
	const releaseRebuild = await rebuildStore.acquireSupervisor("rebuild");
	const rebuilt = await loadOrRebuildValidatedRun(rebuildStore, 10);
	await releaseRebuild();
	assert.equal(rebuilt.snapshot.status, "complete");
	assert.equal(rebuilt.snapshot.schemaVersion, 2);
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("v2 unknown dispatch remains protected and is not re-emitted after restart", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-unknown-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-unknown"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.emit = function (channel: string, data: unknown) {
		for (const handler of (this as any).handlers.get(channel) ?? []) handler(data);
		if (channel === "subagents:rpc:v1:request" && (data as { method?: string }).method === "spawn") this.spawns += 1;
	};
	const first = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(first.status, "needs_attention");
	assert.equal(bus.spawns, 1);
	const second = await new GraphRunner(graph, first, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(second.status, "needs_attention");
	assert.equal(bus.spawns, 1);
});

test("v2 rejects external writes and trusted loading detects acceptance tampering", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-tamper-"));
	assert.throws(() => compileGraph({
		schemaVersion: 1,
		goal: "external",
		nodes: [{ taskId: "external", agent: "worker", task: "send", outputArtifact: "out.md", sideEffect: "external_write" }],
	}, cwd, 10, 2), /does not support external_write/);

	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-tamper"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const acceptancePath = store.path("nodes", "read", "attempt-1", "acceptance.json");
	const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
	acceptance.outputDigest = "0".repeat(64);
	await writeFile(acceptancePath, JSON.stringify(acceptance));
	await assert.rejects(loadValidatedRun(store, 10), /Acceptance output (?:digest mismatch|does not match validated output)/);
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("restore rolls back and protects Trash when v2 evidence was tampered", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-restore-tamper-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-restore-tamper"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const plan = await createPrunePlan(runs, [graph.graphId]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 7, plan.planDigest);
	const acceptancePath = join(runs, ".trash", trashId!, "nodes", "read", "attempt-1", "acceptance.json");
	const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
	acceptance.outputDigest = "0".repeat(64);
	await writeFile(acceptancePath, JSON.stringify(acceptance));
	await assert.rejects(restoreTrash(runs, trashId!), /Acceptance output/);
	const inventory = await listTrashInventory(runs);
	assert.equal(inventory.valid.length, 0);
	assert.equal(inventory.protected[0]?.trashId, trashId);
	assert.match(inventory.protected[0]?.reason ?? "", /Restore protection/);
	assert.equal((await GraphStore.list(runs)).includes(graph.graphId), false);
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("terminal projection rebuild preserves a failed attempt followed by an accepted retry", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-retry-rebuild-"));
	const runs = join(cwd, "runs");
	const retrySpec = spec("v2-retry-rebuild");
	retrySpec.nodes[0]!.retryPolicy = { maxAttempts: 2, backoffMs: 1, retryOn: ["failed"] };
	const graph = compileGraph(retrySpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.omitOutputCount = 1;
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.status, "complete");
	assert.equal(terminal.nodes.read?.attempts.length, 2);
	assert.equal(terminal.nodes.read?.attempts[0]?.status, "failed");
	assert.equal(terminal.nodes.read?.attempts[1]?.status, "accepted");
	await writeFile(store.path("snapshot.json"), "{corrupt");
	const rebuildStore = new GraphStore(runs, graph.graphId);
	const release = await rebuildStore.acquireSupervisor("retry-rebuild");
	const rebuilt = await loadOrRebuildValidatedRun(rebuildStore, 10);
	await release();
	assert.deepEqual(rebuilt.snapshot.nodes.read?.attempts.map((attempt) => attempt.status), ["failed", "accepted"]);
	assert.equal(rebuilt.snapshot.nodes.read?.attempt, 2);
	for (const attempt of terminal.nodes.read?.attempts ?? []) {
		if (attempt.asyncDir) await rm(attempt.asyncDir, { recursive: true, force: true });
	}
});

test("legacy v2 authorization permits a failed snapshot without retry-kind projections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-projection-compat-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-projection-compat"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.omitOutputCount = 1;
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.nodes.read?.status, "failed");
	const authorization = JSON.parse(await readFile(store.path("authorization.json"), "utf8"));
	delete authorization.compilerProjectionVersion;
	delete authorization.graph.projectionVersion;
	authorization.graphDigest = canonicalDigest(authorization.graph);
	await writeFile(store.path("authorization.json"), JSON.stringify(authorization));
	const legacySnapshot = structuredClone(terminal);
	legacySnapshot.nodes.read!.failure = undefined;
	legacySnapshot.nodes.read!.attempts[0]!.failure = undefined;
	const legacyStore = new GraphStore(runs, graph.graphId);
	const releaseLegacy = await legacyStore.acquireSupervisor("write-legacy-failed-projection");
	await legacyStore.saveSnapshot(legacySnapshot);
	await releaseLegacy();
	const loaded = (await loadValidatedRun(new GraphStore(runs, graph.graphId), 10)).snapshot;
	assert.equal(loaded.graphId, graph.graphId);
	assert.equal(loaded.nodes.read?.status, "failed");
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("trusted loading rejects malformed authority timestamps and evidence identities", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-evidence-fields-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-evidence-fields"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const validatedPath = store.path("nodes", "read", "attempt-1", "validated-result.json");
	const validated = JSON.parse(await readFile(validatedPath, "utf8"));
	validated.validatedAt = "not-a-time";
	await writeFile(validatedPath, JSON.stringify(validated));
	await assert.rejects(loadValidatedRun(store, 10), /timestamp/);
	validated.validatedAt = new Date().toISOString();
	validated.graphId = "different";
	await writeFile(validatedPath, JSON.stringify(validated));
	await assert.rejects(loadValidatedRun(store, 10), /identity mismatch/);
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("trusted loading rejects accepted projection with non-accepted authority", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-authority-state-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-authority-state"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const authorityPath = store.path("nodes", "read", "attempt-1", "attempt.json");
	const authority = JSON.parse(await readFile(authorityPath, "utf8"));
	await assert.rejects(
		new GraphStore(runs, graph.graphId).writeAttemptRecord("read", 1, { ...authority, phase: "running", updatedAt: new Date().toISOString() }),
		/Illegal attempt authority phase transition/,
	);
	authority.phase = "running";
	await writeFile(authorityPath, JSON.stringify(authority));
	await assert.rejects(loadValidatedRun(store, 10), /Accepted snapshot requires accepted authority/);
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("attempt authority identity, terminal evidence, and recovery authorization are immutable", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-attempt-immutable-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-attempt-immutable"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const base = {
		schemaVersion: 2 as const,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: "owner",
		fencingGeneration: 1,
		updatedAt: new Date().toISOString(),
	};
	await store.writeAttemptRecord("read", 1, { ...base, phase: "prepared" });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", requestDigest: "1".repeat(64), updatedAt: new Date().toISOString() });
	await assert.rejects(
		store.writeAttemptRecord("read", 1, { ...base, phase: "running", requestDigest: "2".repeat(64), asyncId: "child", updatedAt: new Date().toISOString() }),
		/requestDigest cannot change/,
	);
	await store.writeAttemptRecord("read", 1, { ...base, phase: "terminal", terminalStatus: "stale", updatedAt: new Date().toISOString() });
	await assert.rejects(
		store.writeAttemptRecord("read", 1, { ...base, phase: "terminal", terminalStatus: "stale", terminalError: "changed", updatedAt: new Date().toISOString() }),
		/terminalError cannot change/,
	);
	await writeFile(store.path("nodes", "read", "attempt-1", "attempt-recovery.json"), JSON.stringify({
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		attemptNonce,
		fromStatus: "stale",
		toStatus: "running",
		preparedAt: "not-a-time",
	}));
	await assert.rejects(
		store.writeAttemptRecord("read", 1, { ...base, phase: "collecting", updatedAt: new Date().toISOString() }),
		/Illegal attempt authority phase transition/,
	);
});

test("attempt recovery journal bridges the authority-first collecting crash window", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-attempt-recovery-window-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-attempt-recovery-window"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.read = {
		taskId: "read",
		status: "running",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "running",
			sessionDir: join(attemptRoot, "session"),
			workspaceDir: join(attemptRoot, "workspace"),
			workspaceKind: "shadow",
		}],
	};
	await store.saveSnapshot(snapshot);
	const authority = {
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
	await store.writeAttemptRecord("read", 1, { ...authority, phase: "prepared" });
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
	await store.writeAttemptRecord("read", 1, { ...authority, phase: "terminal", terminalStatus: "stale", updatedAt: new Date().toISOString() });
	await store.prepareAttemptRecovery("read", 1, "running");
	const recoveryRunner = new GraphRunner(graph, snapshot, store, new V2Subagents(), new LeaseRegistry(join(runs, ".control", "leases")), config(runs));
	await (recoveryRunner as unknown as { recoverAuthoritativeTerminalAttempts(): Promise<void> }).recoverAuthoritativeTerminalAttempts();
	assert.equal(snapshot.nodes.read.status, "running");
	assert.equal((await store.readAttemptRecord("read", 1)).phase, "terminal");
	await store.writeAttemptRecord("read", 1, { ...authority, phase: "collecting", updatedAt: new Date().toISOString() });

	assert.equal((await loadValidatedRun(store, 10)).snapshot.nodes.read?.status, "running");
	snapshot.nodes.read.status = "collecting";
	snapshot.nodes.read.attempts[0]!.status = "collecting";
	await store.saveSnapshot(snapshot);
	assert.equal((await loadValidatedRun(store, 10)).snapshot.nodes.read?.status, "collecting");
	await store.completeAttemptRecovery("read", 1);
	assert.equal((await loadValidatedRun(store, 10)).snapshot.nodes.read?.status, "collecting");
});

test("resource wait preserves an active v2 attempt as trusted state", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-resource-wait-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-resource-wait"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.read = {
		taskId: "read",
		status: "resource_wait",
		attempt: 1,
		nextRetryAt: Date.now() + 1_000,
		attempts: [{ attempt: 1, attemptNonce, status: "running", sessionDir: join(attemptRoot, "session"), workspaceKind: "shadow" }],
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
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", requestDigest: "0".repeat(64), updatedAt: new Date().toISOString() });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "running", requestDigest: "0".repeat(64), updatedAt: new Date().toISOString() });
	assert.equal((await loadValidatedRun(store, 10)).snapshot.nodes.read?.status, "resource_wait");
});

test("an accepted authority resumes from verifying without another child or phase regression", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-accepted-ahead-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-accepted-ahead"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const firstBus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, firstBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const recoveryStore = new GraphStore(runs, graph.graphId);
	terminal.status = "running";
	terminal.nodes.read!.status = "verifying";
	terminal.nodes.read!.attempts[0]!.status = "verifying";
	await recoveryStore.saveSnapshot(terminal);
	assert.equal((await loadValidatedRun(recoveryStore, 10)).snapshot.nodes.read?.status, "verifying");

	const resumeBus = new V2Subagents();
	const resumed = await new GraphRunner(graph, terminal, recoveryStore, resumeBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(resumed.status, "complete");
	assert.equal(resumeBus.spawns, 0);
	assert.equal((await recoveryStore.readAttemptRecord("read", 1)).phase, "accepted");
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("durable stop preserves an accepted authority that is ahead of its snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-accepted-stop-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-accepted-stop"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const completed = await new GraphRunner(graph, snapshot, store, new V2Subagents(), new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const recoveryStore = new GraphStore(runs, graph.graphId);
	completed.status = "running";
	completed.nodes.read!.status = "verifying";
	completed.nodes.read!.attempts[0]!.status = "verifying";
	await recoveryStore.saveSnapshot(completed);
	await recoveryStore.recordDesiredState("stopped");

	const bus = new V2Subagents();
	const recovered = await new GraphRunner(graph, completed, recoveryStore, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(recovered.status, "complete");
	assert.equal(recovered.nodes.read?.status, "accepted");
	assert.equal((await recoveryStore.readAttemptRecord("read", 1)).phase, "accepted");
	assert.equal(bus.spawns, 0);
	assert.equal(bus.stopCalls, 0);
	assert.equal((await loadValidatedRun(recoveryStore, 10)).snapshot.status, "complete");
	const child = recovered.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

for (const phase of ["validated", "applying"] as const) {
	test(`a ${phase} authority resumes finalization without returning to collecting`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), `pi-graph-v2-${phase}-ahead-`));
		const runs = join(cwd, "runs");
		const graph = compileGraph(spec(`v2-${phase}-ahead`), cwd, 10, 2);
		const snapshot = initialSnapshot(graph, cwd, "owner", 2);
		const store = new GraphStore(runs, graph.graphId);
		await store.initialize(graph, snapshot);
		const firstBus = new V2Subagents();
		const terminal = await new GraphRunner(graph, snapshot, store, firstBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
		const authorityPath = store.path("nodes", "read", "attempt-1", "attempt.json");
		const authority = JSON.parse(await readFile(authorityPath, "utf8"));
		authority.phase = phase;
		authority.updatedAt = new Date().toISOString();
		await writeFile(authorityPath, JSON.stringify(authority));
		const recoveryStore = new GraphStore(runs, graph.graphId);
		terminal.status = "running";
		terminal.nodes.read!.status = "verifying";
		terminal.nodes.read!.attempts[0]!.status = "verifying";
		await recoveryStore.saveSnapshot(terminal);
		assert.equal((await loadValidatedRun(recoveryStore, 10)).snapshot.nodes.read?.status, "verifying");

		const resumeBus = new V2Subagents();
		const resumed = await new GraphRunner(graph, terminal, recoveryStore, resumeBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
		assert.equal(resumed.status, "complete");
		assert.equal(resumeBus.spawns, 0);
		assert.equal((await recoveryStore.readAttemptRecord("read", 1)).phase, "accepted");
		const child = terminal.nodes.read?.attempts[0]?.asyncDir;
		if (child) await rm(child, { recursive: true, force: true });
	});
}

test("a terminal authority ahead of an active snapshot is projected without redispatch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-terminal-ahead-"));
	const runs = join(cwd, "runs");
	const failureSpec = spec("v2-terminal-ahead");
	failureSpec.nodes[0]!.retryPolicy = { maxAttempts: 1, retryOn: ["dispatch"] };
	const graph = compileGraph(failureSpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const firstBus = new V2Subagents();
	firstBus.rejectSpawnCount = 1;
	const failed = await new GraphRunner(graph, snapshot, store, firstBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(failed.status, "failed");
	const recoveryStore = new GraphStore(runs, graph.graphId);
	failed.status = "running";
	failed.nodes.read!.status = "running";
	failed.nodes.read!.attempts[0]!.status = "running";
	await recoveryStore.saveSnapshot(failed);
	assert.equal((await loadValidatedRun(recoveryStore, 10)).snapshot.nodes.read?.status, "running");

	const resumeBus = new V2Subagents();
	const resumed = await new GraphRunner(graph, failed, recoveryStore, resumeBus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(resumed.status, "failed");
	assert.equal(resumed.nodes.read?.status, "failed");
	assert.equal(resumeBus.spawns, 0);
});

test("retry-wait rejects a terminal retry kind outside the compiled policy", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-retry-wait-policy-"));
	const runs = join(cwd, "runs");
	const retrySpec = spec("v2-retry-wait-policy");
	retrySpec.nodes[0]!.retryPolicy = { maxAttempts: 2, retryOn: ["failed"], backoffMs: 60_000 };
	const graph = compileGraph(retrySpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.rejectSpawnCount = 1;
	const failed = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(failed.status, "failed");
	const recoveryStore = new GraphStore(runs, graph.graphId);
	failed.status = "running";
	failed.nodes.read!.status = "retry_wait";
	failed.nodes.read!.attempts[0]!.status = "failed";
	failed.nodes.read!.nextRetryAt = Date.now() + 60_000;
	await recoveryStore.saveSnapshot(failed);
	await assert.rejects(loadValidatedRun(recoveryStore, 10), /Retry-wait kind is not authorized/);
	const authorityPath = recoveryStore.path("nodes", "read", "attempt-1", "attempt.json");
	const authority = JSON.parse(await readFile(authorityPath, "utf8"));
	delete authority.terminalRetryKind;
	await writeFile(authorityPath, JSON.stringify(authority));
	await assert.rejects(loadValidatedRun(recoveryStore, 10), /missing its retry kind/);
});

test("terminal authority recovery restores fail-fast before independent nodes dispatch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-fail-fast-recovery-"));
	const runs = join(cwd, "runs");
	const failFastSpec: GraphSpec = {
		schemaVersion: 1,
		graphId: "v2-fail-fast-recovery",
		goal: "fail fast",
		failFast: true,
		nodes: [
			{ taskId: "first", agent: "scout", task: "first", outputArtifact: "first.md", sideEffect: "local_read" },
			{ taskId: "second", agent: "scout", task: "second", outputArtifact: "second.md", sideEffect: "local_read" },
		],
	};
	const graph = compileGraph(failFastSpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "first", "attempt-1");
	const secondNonce = randomUUID();
	const secondRoot = store.path("nodes", "second", "attempt-1");
	const secondAsyncId = `fail-fast-${randomUUID()}`;
	const secondAsyncDir = join(subagentAsyncRoot(), secondAsyncId);
	await mkdir(secondAsyncDir, { recursive: true });
	await writeFile(join(secondAsyncDir, "status.json"), JSON.stringify({ runId: secondAsyncId, state: "running", sessionId: "owner", sessionDir: join(secondRoot, "session", "child") }));
	snapshot.status = "running";
	snapshot.nodes.first = {
		taskId: "first",
		status: "running",
		attempt: 1,
		attempts: [{ attempt: 1, attemptNonce, status: "running", sessionDir: join(attemptRoot, "session"), workspaceKind: "shadow" }],
	};
	snapshot.nodes.second = {
		taskId: "second",
		status: "resource_wait",
		attempt: 1,
		nextRetryAt: Date.now() + 60_000,
		attempts: [{
			attempt: 1,
			attemptNonce: secondNonce,
			status: "running",
			sessionDir: join(secondRoot, "session"),
			workspaceKind: "shadow",
			asyncId: secondAsyncId,
			asyncDir: secondAsyncDir,
		}],
	};
	await store.saveSnapshot(snapshot);
	const base = {
		schemaVersion: 2 as const,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "first",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: snapshot.supervisorEpoch,
		fencingGeneration: snapshot.fencingGeneration,
		updatedAt: new Date().toISOString(),
	};
	await store.writeAttemptRecord("first", 1, { ...base, phase: "prepared" });
	await store.writeWorkspaceRecord("first", 1, {
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "first",
		attempt: 1,
		workspaceKind: "shadow",
		contractDigest: "0".repeat(64),
		writeBaseline: {},
		readBaseline: {},
		inputBaseline: {},
		createdAt: new Date().toISOString(),
	});
	await store.writeAttemptRecord("first", 1, { ...base, phase: "terminal", terminalStatus: "failed", terminalRetryKind: "failed", updatedAt: new Date().toISOString() });
	const secondBase = { ...base, taskId: "second", attemptNonce: secondNonce };
	await store.writeAttemptRecord("second", 1, { ...secondBase, phase: "prepared" });
	await store.writeWorkspaceRecord("second", 1, {
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "second",
		attempt: 1,
		workspaceKind: "shadow",
		contractDigest: "0".repeat(64),
		writeBaseline: {},
		readBaseline: {},
		inputBaseline: {},
		createdAt: new Date().toISOString(),
	});
	await store.writeAttemptRecord("second", 1, { ...secondBase, phase: "dispatching", requestDigest: "1".repeat(64), updatedAt: new Date().toISOString() });
	await store.writeAttemptRecord("second", 1, { ...secondBase, phase: "running", requestDigest: "1".repeat(64), asyncId: secondAsyncId, updatedAt: new Date().toISOString() });
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.status, "failed");
	assert.equal(terminal.nodes.first?.status, "failed");
	assert.equal(terminal.nodes.second?.status, "stopped");
	assert.equal(bus.spawns, 0);
	assert.equal(bus.stopCalls, 1);
	assert.equal((await store.readAttemptRecord("second", 1)).terminalStatus, "stopped");
	await rm(secondAsyncDir, { recursive: true, force: true });
});

test("fail-fast preserves an independently accepted authority ahead of its snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-fail-fast-accepted-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-fail-fast-accepted",
		goal: "preserve accepted sibling",
		failFast: true,
		nodes: [
			{ taskId: "failed", agent: "scout", task: "first", outputArtifact: "failed.md", sideEffect: "local_read" },
			{ taskId: "accepted", agent: "scout", task: "second", outputArtifact: "accepted.md", sideEffect: "local_read" },
		],
	} as GraphSpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const completed = await new GraphRunner(graph, snapshot, store, new V2Subagents(), new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const firstAuthorityPath = store.path("nodes", "failed", "attempt-1", "attempt.json");
	const firstAuthority = JSON.parse(await readFile(firstAuthorityPath, "utf8"));
	Object.assign(firstAuthority, {
		phase: "terminal",
		terminalStatus: "failed",
		terminalError: "fault injected before snapshot projection",
		terminalRetryKind: "failed",
		updatedAt: new Date().toISOString(),
	});
	await writeFile(firstAuthorityPath, JSON.stringify(firstAuthority));
	const recoveryStore = new GraphStore(runs, graph.graphId);
	completed.status = "running";
	completed.nodes.failed!.status = "running";
	completed.nodes.failed!.attempts[0]!.status = "running";
	completed.nodes.accepted!.status = "verifying";
	completed.nodes.accepted!.attempts[0]!.status = "verifying";
	await recoveryStore.saveSnapshot(completed);
	assert.equal((await loadValidatedRun(recoveryStore, 10)).snapshot.status, "running");

	const bus = new V2Subagents();
	const recovered = await new GraphRunner(graph, completed, recoveryStore, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(recovered.status, "failed");
	assert.equal(recovered.nodes.failed?.status, "failed");
	assert.equal(recovered.nodes.accepted?.status, "accepted");
	assert.equal((await recoveryStore.readAttemptRecord("accepted", 1)).phase, "accepted");
	assert.equal(bus.spawns, 0);
	assert.equal(bus.stopCalls, 0);
	for (const state of Object.values(recovered.nodes)) {
		const child = state.attempts[0]?.asyncDir;
		if (child) await rm(child, { recursive: true, force: true });
	}
});

test("resource-wait keeps supervising an active child without an implicit deadline", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-resource-timeout-stop-"));
	const runs = join(cwd, "runs");
	const timeoutSpec = spec("v2-resource-timeout-stop");
	timeoutSpec.nodes[0]!.timeoutMs = 1_000;
	const graph = compileGraph(timeoutSpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	const asyncId = `resource-timeout-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "owner", sessionDir: join(attemptRoot, "session", "child") }));
	snapshot.status = "running";
	snapshot.nodes.read = {
		taskId: "read",
		status: "resource_wait",
		attempt: 1,
		resourceWaitStartedAt: Date.now() - 10_000,
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
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", requestDigest: "2".repeat(64), asyncId });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "running", requestDigest: "2".repeat(64), asyncId });
	const bus = new V2Subagents();
	const runner = new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs));
	await (runner as unknown as { handleResult(taskId: string, result: { status: "resource_wait"; error: string }): Promise<void> }).handleResult("read", {
		status: "resource_wait",
		error: "lease unavailable",
	});
	assert.equal(snapshot.nodes.read?.status, "resource_wait");
	assert.equal((await store.readAttemptRecord("read", 1)).phase, "running");
	assert.equal(JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")).state, "running");
	assert.equal(bus.stopCalls, 0);
	await rm(asyncDir, { recursive: true, force: true });
});

test("durable stop preserves an immutable failed authority from retry-wait", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-stop-retry-wait-"));
	const runs = join(cwd, "runs");
	const retrySpec: GraphSpec = {
		schemaVersion: 1,
		graphId: "v2-stop-retry-wait",
		goal: "stop retry",
		nodes: [{
			taskId: "read",
			agent: "scout",
			task: "read",
			outputArtifact: "read.md",
			sideEffect: "local_read",
			retryPolicy: { maxAttempts: 2, backoffMs: 60_000, retryOn: ["failed"] },
		}],
	};
	const graph = compileGraph(retrySpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected a v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.read = {
		taskId: "read",
		status: "retry_wait",
		attempt: 1,
		nextRetryAt: Date.now() + 60_000,
		failure: { kind: "task_failed", retryKind: "failed" },
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "failed",
			sessionDir: join(attemptRoot, "session"),
			workspaceKind: "shadow",
			failure: { kind: "task_failed", retryKind: "failed" },
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
	await store.writeAttemptRecord("read", 1, { ...base, phase: "terminal", terminalStatus: "failed", terminalRetryKind: "failed", updatedAt: new Date().toISOString() });
	await store.requestControl("stop");
	const terminal = await new GraphRunner(graph, snapshot, store, new V2Subagents(), new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.status, "stopped");
	assert.equal(terminal.nodes.read?.status, "failed");
	assert.equal((await store.readAttemptRecord("read", 1)).terminalStatus, "failed");
	assert.equal((await loadValidatedRun(store, 10)).snapshot.status, "stopped");
});

test("rebuild validates the complete evidence chain before replacing a corrupt snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-rebuild-precommit-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph(spec("v2-rebuild-precommit"), cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	const manifestPath = join(attemptRoot, "result-manifest.json");
	const acceptancePath = join(attemptRoot, "acceptance.json");
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	manifest.validation = [{ command: "node --version", ok: true, exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 }];
	const manifestText = JSON.stringify(manifest);
	await writeFile(manifestPath, manifestText);
	const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
	acceptance.manifestDigest = createHash("sha256").update(manifestText).digest("hex");
	await writeFile(acceptancePath, JSON.stringify(acceptance));
	await writeFile(store.path("snapshot.json"), "{corrupt");

	await assert.rejects(loadOrRebuildValidatedRun(store, 10));
	assert.equal(await readFile(store.path("snapshot.json"), "utf8"), "{corrupt");
	const child = terminal.nodes.read?.attempts[0]?.asyncDir;
	if (child) await rm(child, { recursive: true, force: true });
});

test("an explicit child rejection is retryable and never becomes dispatch_unknown", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-rejected-retry-"));
	const runs = join(cwd, "runs");
	const retrySpec = spec("v2-rejected-retry");
	retrySpec.nodes[0]!.retryPolicy = { maxAttempts: 2, backoffMs: 1, retryOn: ["dispatch"] };
	const graph = compileGraph(retrySpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "owner", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new V2Subagents();
	bus.rejectSpawnCount = 1;
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config(runs)).run();
	assert.equal(terminal.status, "complete");
	assert.equal(bus.spawns, 2);
	assert.deepEqual(terminal.nodes.read?.attempts.map((attempt) => attempt.status), ["failed", "accepted"]);
	assert.equal(terminal.nodes.read?.attempts.some((attempt) => attempt.status === "dispatch_unknown"), false);
	const firstAuthorityPath = store.path("nodes", "read", "attempt-1", "attempt.json");
	const firstAuthority = JSON.parse(await readFile(firstAuthorityPath, "utf8"));
	assert.equal(firstAuthority.terminalRetryKind, "dispatch");
	firstAuthority.terminalRetryKind = "failed";
	await writeFile(firstAuthorityPath, JSON.stringify(firstAuthority));
	await assert.rejects(loadValidatedRun(store, 10), /Snapshot failure retry kind does not match authority/);
	for (const attempt of terminal.nodes.read?.attempts ?? []) {
		if (attempt.asyncDir) await rm(attempt.asyncDir, { recursive: true, force: true });
	}
});
