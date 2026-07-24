import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraph } from "../src/compile.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { GraphRunner, initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import { loadValidatedRun } from "../src/reconciler.ts";
import { subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { prepareWorkspace } from "../src/workspace.ts";
import type { GraphConfig, GraphSpec } from "../src/types.ts";

class FakeSubagents implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	readonly starts: Array<{ task: string; at: number }> = [];
	readonly recoveryHandoffs: string[] = [];
	private readonly taskAttempts = new Map<string, number>();
	private fanoutArrivals = 0;
	private releaseFanout!: () => void;
	private readonly fanoutBarrier = new Promise<void>((resolve) => { this.releaseFanout = resolve; });
	on(channel: string, handler: (data: unknown) => void) { const set = this.handlers.get(channel) ?? new Set(); set.add(handler); this.handlers.set(channel, set); return () => set.delete(handler); }
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method !== "spawn") return;
		const id = `run-${request.requestId.slice(-8)}`;
		const asyncDir = join(subagentAsyncRoot(), id);
			const output = request.params.output as string;
			const task = request.params.task as string;
			this.starts.push({ task, at: Date.now() });
			const attemptKey = task.includes("RATE_LIMIT_ONCE") ? "RATE_LIMIT_ONCE" : task.includes("RETRY_ONCE") ? "RETRY_ONCE" : task.includes("STALE_FIRST_OUTPUT") ? "STALE_FIRST_OUTPUT" : task;
			const taskAttempt = (this.taskAttempts.get(attemptKey) ?? 0) + 1;
			this.taskAttempts.set(attemptKey, taskAttempt);
		void (async () => {
			try {
				this.recoveryHandoffs.push(await readFile(join(request.params.cwd as string, ".pi-graph", "recovery-handoff.md"), "utf8"));
			} catch {
				// First attempts do not have a recovery handoff.
			}
			if (task.endsWith("\nA") || task.endsWith("\nB")) {
				this.fanoutArrivals += 1;
				if (this.fanoutArrivals === 2) this.releaseFanout();
				await this.fanoutBarrier;
			}
			await mkdir(asyncDir, { recursive: true });
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "running", startedAt: Date.now(), mode: "single", sessionDir: request.params.sessionDir }));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId: id, asyncDir } } });
			await new Promise((resolve) => setTimeout(resolve, 30));
			if (task.includes("PARTIAL_LOCAL_WRITE")) {
				await writeFile(join(request.params.cwd as string, "target.md"), "partial-after\n");
				await mkdir(join(output, ".."), { recursive: true });
				await writeFile(output, "partial implementation evidence");
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "failed", error: "synthetic partial failure", mode: "single", sessionDir: request.params.sessionDir }));
				this.emit("subagent:async-complete", { runId: id, asyncDir });
				return;
			}
			if (task.includes("RATE_LIMIT_ONCE") && taskAttempt === 1) {
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "failed", error: "HTTP 429 too many requests; retry-after: 0 seconds", mode: "single", sessionDir: request.params.sessionDir }));
				this.emit("subagent:async-complete", { runId: id, asyncDir });
				return;
			}
			if (task.includes("PAUSE")) {
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "paused", mode: "single", sessionDir: request.params.sessionDir }));
				this.emit("subagent:async-complete", { runId: id, asyncDir });
				return;
			}
				if (task.includes("STALE_FIRST_OUTPUT")) {
					if (taskAttempt === 1) {
					await mkdir(join(output, ".."), { recursive: true });
					await writeFile(output, "stale attempt output");
					await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "failed", error: "retry", mode: "single", sessionDir: request.params.sessionDir }));
					this.emit("subagent:async-complete", { runId: id, asyncDir });
					return;
				}
					await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "complete", mode: "single", sessionDir: request.params.sessionDir }));
					this.emit("subagent:async-complete", { runId: id, asyncDir });
					return;
				}
				if (task.includes("SYMLINK_OUTPUT")) {
					await mkdir(join(output, ".."), { recursive: true });
					const victim = join(asyncDir, "victim.md");
					await writeFile(victim, "victim");
					await symlink(victim, output);
					await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "complete", mode: "single", outputFile: output, sessionDir: request.params.sessionDir }));
					this.emit("subagent:async-complete", { runId: id, asyncDir, results: [{ summary: "symlink output" }] });
					return;
				}
			const shouldFail = task.includes("ALWAYS_FAIL") || (task.includes("RETRY_ONCE") && taskAttempt === 1);
			if (shouldFail) {
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "failed", error: "synthetic failure", startedAt: Date.now(), endedAt: Date.now(), mode: "single", sessionDir: request.params.sessionDir }));
				this.emit("subagent:async-complete", { runId: id, asyncDir, results: [{ summary: "synthetic failure" }] });
				return;
			}
				await mkdir(join(output, ".."), { recursive: true });
				if (task.includes("LOCAL_WRITE")) await writeFile(join(request.params.cwd as string, "target.md"), "after\n");
				if (task.includes("LOCAL_WRITE_MANY")) {
					for (let index = 0; index < 250; index += 1) await writeFile(join(request.params.cwd as string, "data", `file-${index}.txt`), `after-${index}\n`);
				}
			await writeFile(output, `output for ${id}`);
			const outputLog = join(asyncDir, "output.log");
			await writeFile(outputLog, `output for ${id}`);
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: id, state: "complete", startedAt: Date.now(), endedAt: Date.now(), mode: "single", outputFile: outputLog, sessionDir: request.params.sessionDir }));
			this.emit("subagent:async-complete", { runId: id, asyncDir, results: [{ summary: `output for ${id}` }] });
		})();
	}
}

class HangingSubagents implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	started = false;
	stopCalls = 0;
	on(channel: string, handler: (data: unknown) => void) { const set = this.handlers.get(channel) ?? new Set(); set.add(handler); this.handlers.set(channel, set); return () => set.delete(handler); }
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "stop") {
			this.stopCalls += 1;
			return;
		}
		if (request.method !== "spawn") return;
		const asyncId = `pi-graph-hanging-${request.requestId}`;
		const asyncDir = join(subagentAsyncRoot(), asyncId);
		void (async () => {
			await mkdir(asyncDir, { recursive: true });
			await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "session", sessionDir: join(request.params.sessionDir as string, `async-${asyncId}`) }));
			this.started = true;
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId, asyncDir } } });
		})();
	}
}

const config: GraphConfig = { enabled: true, runsDir: "", maxConcurrency: 3, readOnlyBurst: 3, maxSpawnBudget: 20, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false };

class FailOnceManifestStore extends GraphStore {
	private failed = false;
	override async writeJson(relativePath: string, value: unknown): Promise<string> {
		if (!this.failed && relativePath.endsWith("result-manifest.json")) {
			this.failed = true;
			throw new Error("synthetic manifest failure");
		}
		return super.writeJson(relativePath, value);
	}
}

test("runner fans out independent nodes and joins only after both are accepted", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	config.runsDir = runs;
	const spec = { schemaVersion: 1, graphId: "fanout", goal: "parallel", workspace: "shadow", nodes: [
		{ taskId: "a", agent: "researcher", task: "A", outputArtifact: "a.md", sideEffect: "none" },
		{ taskId: "b", agent: "researcher", task: "B", outputArtifact: "b.md", sideEffect: "none" },
		{ taskId: "join", agent: "decision-reviewer", task: "join", dependsOn: ["a", "b"], inputArtifacts: ["a.md", "b.md"], outputArtifact: "join.md", sideEffect: "none" },
	] } as GraphSpec;
	const graph = compileGraph(spec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), config).run();
	assert.equal(terminal.status, "complete");
	assert.equal(terminal.nodes.join?.status, "accepted");
	assert.equal(bus.starts.length, 3);
	assert.ok(bus.starts.slice(0, 2).every(({ task }) => task.endsWith("\nA") || task.endsWith("\nB")), "both fanout nodes must dispatch before either can complete");
	assert.ok(bus.starts[2]!.task.endsWith("\njoin"), "join must dispatch only after both upstream nodes complete");
});

test("runner blocks failed descendants while an independent branch completes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "branches", goal: "branches", workspace: "shadow", nodes: [
		{ taskId: "bad", agent: "researcher", task: "ALWAYS_FAIL", outputArtifact: "bad.md", sideEffect: "none" },
		{ taskId: "blocked", agent: "reviewer", task: "must not run", dependsOn: ["bad"], outputArtifact: "blocked.md", sideEffect: "none" },
		{ taskId: "independent", agent: "researcher", task: "independent", outputArtifact: "independent.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "failed");
	assert.equal(terminal.nodes.bad?.status, "failed");
	assert.equal(terminal.nodes.blocked?.status, "blocked");
	assert.equal(terminal.nodes.independent?.status, "accepted");
	assert.equal(bus.starts.length, 2);
});

test("runner retries only within the declared attempt budget", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "retry", goal: "retry", workspace: "shadow", nodes: [
		{ taskId: "retry", agent: "researcher", task: "RETRY_ONCE", outputArtifact: "retry.md", sideEffect: "none", retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["failed"] } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.nodes.retry!.resourceWaitStartedAt = Date.now() - 1_000;
	snapshot.nodes.retry!.nextRetryAt = Date.now() + 10_000;
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "complete");
	assert.equal(terminal.nodes.retry?.attempt, 2);
	assert.equal(bus.starts.length, 2);
	assert.deepEqual(terminal.nodes.retry?.attempts.map((attempt) => attempt.status), ["failed", "accepted"]);
	assert.notEqual(terminal.nodes.retry?.attempts[0]?.outputPath, terminal.nodes.retry?.attempts[1]?.outputPath);
	const persisted = await store.loadSnapshot();
	assert.equal(persisted.nodes.retry?.resourceWaitStartedAt, undefined);
	assert.equal(persisted.nodes.retry?.nextRetryAt, undefined);
	assert.equal(bus.recoveryHandoffs.length, 1);
	assert.match(bus.recoveryHandoffs[0]!, /Prior status: failed/);
	assert.match(bus.recoveryHandoffs[0]!, /synthetic failure/);
});

test("failed writers preserve partial evidence without applying it to the source workspace", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-partial-writer-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "before\n");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "partial-writer",
		goal: "preserve partial work",
		workspace: "shadow",
		nodes: [{
			taskId: "write",
			agent: "frontend-developer",
			task: "PARTIAL_LOCAL_WRITE",
			outputArtifact: "result.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "target.md" }],
			validationCommands: ["test -f target.md"],
		}],
	} as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "failed");
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "before\n");
	const attempt = terminal.nodes.write?.attempts[0];
	assert.ok(attempt?.manifestPath);
	const manifest = JSON.parse(await readFile(attempt.manifestPath, "utf8")) as { status: string; writes: Array<{ path: string; after?: string }>; outputDigest?: string };
	assert.equal(manifest.status, "partial");
	assert.equal(manifest.writes.length, 1);
	assert.equal(manifest.writes[0]?.path.endsWith("/target.md"), true);
	assert.ok(manifest.writes[0]?.after);
	assert.ok(manifest.outputDigest);
});

test("provider retries use a separate budget and retain typed failure evidence", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-provider-retry-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs, runtimeV2Dispatch: true };
	const graph = compileGraph({ schemaVersion: 1, graphId: "provider-retry", goal: "provider retry", workspace: "shadow", nodes: [
		{
			taskId: "retry",
			agent: "frontend-developer",
			resourceClass: "provider:kimi",
			task: "RATE_LIMIT_ONCE",
			outputArtifact: "retry.md",
			sideEffect: "none",
			retryPolicy: { maxAttempts: 1, maxProviderRetries: 1, providerBackoffMs: 1 },
		},
	] } as GraphSpec, cwd, 20, 2);
	const snapshot = initialSnapshot(graph, cwd, "session", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "complete");
	assert.equal(terminal.nodes.retry?.attempt, 2);
	assert.equal(bus.starts.length, 2);
	assert.equal(terminal.nodes.retry?.attempts[0]?.failure?.kind, "provider_rate_limit");
	assert.equal(terminal.nodes.retry?.attempts[0]?.failure?.retryKind, "provider");
	assert.equal((await store.readAttemptRecord("retry", 1)).terminalRetryKind, "provider");
	const missingProjection = structuredClone(terminal);
	missingProjection.nodes.retry!.attempts[0]!.failure = undefined;
	const missingStore = new GraphStore(runs, graph.graphId);
	const releaseMissing = await missingStore.acquireSupervisor("remove-provider-retry-projection");
	await missingStore.saveSnapshot(missingProjection);
	await releaseMissing();
	await assert.rejects(loadValidatedRun(new GraphStore(runs, graph.graphId), 20), /Snapshot failed attempt is missing its retry kind/);
	const mismatchedProjection = structuredClone(terminal);
	mismatchedProjection.nodes.retry!.attempts[0]!.failure = { kind: "task_failed", retryKind: "failed" };
	const tamperStore = new GraphStore(runs, graph.graphId);
	const releaseTamper = await tamperStore.acquireSupervisor("tamper-provider-retry");
	await tamperStore.saveSnapshot(mismatchedProjection);
	await releaseTamper();
	await assert.rejects(loadValidatedRun(new GraphStore(runs, graph.graphId), 20), /Snapshot failure retry kind does not match authority/);
});

test("a modern v2 failed node must project the same retry kind as its authority", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-failed-projection-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs, runtimeV2Dispatch: true };
	const graph = compileGraph({ schemaVersion: 1, graphId: "failed-projection", goal: "failed projection", workspace: "shadow", nodes: [
		{
			taskId: "fail",
			agent: "researcher",
			task: "ALWAYS_FAIL",
			outputArtifact: "failed.md",
			sideEffect: "none",
			retryPolicy: { maxAttempts: 1 },
		},
	] } as GraphSpec, cwd, 20, 2);
	const snapshot = initialSnapshot(graph, cwd, "session", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.nodes.fail?.status, "failed");
	assert.equal(terminal.nodes.fail?.failure?.retryKind, "failed");
	const mismatchedProjection = structuredClone(terminal);
	mismatchedProjection.nodes.fail!.failure = { kind: "provider_transient", retryKind: "provider" };
	const tamperStore = new GraphStore(runs, graph.graphId);
	const releaseTamper = await tamperStore.acquireSupervisor("tamper-failed-node-projection");
	await tamperStore.saveSnapshot(mismatchedProjection);
	await releaseTamper();
	await assert.rejects(loadValidatedRun(new GraphStore(runs, graph.graphId), 20), /Snapshot node failure retry kind does not match authority/);
});

test("generic resource limits serialize nodes in the same resource class", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-resource-class-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs, resourceLimits: { "agent:researcher": 1 } };
	const graph = compileGraph({ schemaVersion: 1, graphId: "resource-class", goal: "resource class", workspace: "shadow", maxConcurrency: 2, nodes: [
		{ taskId: "a", agent: "researcher", task: "RESOURCE_A", outputArtifact: "a.md", sideEffect: "none" },
		{ taskId: "b", agent: "researcher", task: "RESOURCE_B", outputArtifact: "b.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "complete");
	assert.equal(bus.starts.length, 2);
	assert.ok(bus.starts[1]!.at - bus.starts[0]!.at >= 20, "same resource class must not dispatch concurrently");
});

test("a v2 local-write retry reserves the new attempt instead of the failed attempt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-v2-retry-reservation-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "before\n");
	const localConfig = { ...config, runsDir: runs, runtimeV2Dispatch: true };
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-retry-reservation",
		goal: "retry reservation",
		workspace: "shadow",
		nodes: [{
			taskId: "write",
			agent: "code-implementer",
			task: "RETRY_ONCE LOCAL_WRITE",
			outputArtifact: "result.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "target.md" }],
			validationCommands: ["test -f target.md"],
			retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["failed"] },
		}],
	} as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "complete");
	assert.equal(terminal.nodes.write?.attempt, 2);
	const reservationRoot = join(runs, ".control", "source-reservations", ".history", (snapshot as { runInstanceId: string }).runInstanceId, "write");
	const reservationNames = await readdir(reservationRoot);
	const records = await Promise.all(reservationNames.map(async (name) => JSON.parse(await readFile(join(reservationRoot, name), "utf8")) as { attempt: number }));
	assert.deepEqual(records.map((record) => record.attempt).sort((left, right) => left - right), [1, 2]);
});

test("a retry cannot accept the previous attempt's private output", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "private-output", goal: "private output", workspace: "shadow", nodes: [
		{ taskId: "retry", agent: "researcher", task: "STALE_FIRST_OUTPUT", outputArtifact: "retry.md", sideEffect: "none", retryPolicy: { maxAttempts: 2, backoffMs: 1, retryOn: ["failed"] } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const terminal = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "failed");
	assert.equal(terminal.nodes.retry?.attempt, 2);
	assert.equal(bus.starts.length, 2);
});

test("a paused child yields waiting_input instead of an endless running graph", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "paused", goal: "pause", workspace: "shadow", nodes: [
		{ taskId: "pause", agent: "researcher", task: "PAUSE", outputArtifact: "pause.md", sideEffect: "none" },
		{ taskId: "after", agent: "reviewer", task: "must not run", dependsOn: ["pause"], outputArtifact: "after.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "needs_attention");
	assert.equal(terminal.nodes.pause?.status, "waiting_input");
	assert.equal(terminal.nodes.after?.status, "blocked");
});

test("session suspension releases supervision without stopping the child", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "suspend", goal: "suspend", workspace: "shadow", nodes: [
		{ taskId: "hang", agent: "researcher", task: "hang", outputArtifact: "hang.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new HangingSubagents();
	const runner = new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig);
	const running = runner.run();
	while (!bus.started) await new Promise((resolve) => setTimeout(resolve, 5));
	runner.suspend();
	const suspended = await running;
	assert.equal(suspended.status, "running");
	assert.equal(suspended.nodes.hang?.status, "running");
	assert.equal(bus.stopCalls, 0);
});

test("deadline completion confirmation is enabled only for sandboxed non-bash nodes", async () => {
	const cases = [
		{ suffix: "safe", sideEffect: "none", allowBash: false, expected: true },
		{ suffix: "external", sideEffect: "external_write", allowBash: false, expected: false },
		{ suffix: "bash", sideEffect: "local_write", allowBash: true, expected: false },
	] as const;
	for (const scenario of cases) {
		const cwd = await mkdtemp(join(tmpdir(), `pi-graph-deadline-${scenario.suffix}-`));
		const runs = join(cwd, "runs");
		const graph = compileGraph({
			schemaVersion: 1,
			graphId: `deadline-${scenario.suffix}`,
			goal: "verify deadline quiescence policy",
			workspace: "shadow",
			nodes: [{
				taskId: "deadline",
				agent: "researcher",
				task: "hang until deadline",
				outputArtifact: "deadline.md",
				sideEffect: scenario.sideEffect,
				allowBash: scenario.allowBash,
				...(scenario.allowBash ? { writeScope: [{ kind: "file" as const, path: "target.md" }] } : {}),
				...(scenario.allowBash ? { validationCommands: ["test -f target.md"] } : {}),
				timeoutMs: 1_000,
			}],
		} as GraphSpec, cwd);
		const snapshot = initialSnapshot(graph, cwd, "session");
		const store = new GraphStore(runs, graph.graphId);
		await store.initialize(graph, snapshot);
		const runner = new GraphRunner(graph, snapshot, store, new HangingSubagents(), new LeaseRegistry(join(runs, "leases.json")), { ...config, runsDir: runs });
		const executor = (runner as unknown as {
			executor: {
				stopAndConfirm: (identity: { asyncId: string; asyncDir: string }, acceptComplete?: boolean) => Promise<boolean>;
			};
		}).executor;
		let observedAcceptComplete: boolean | undefined;
		executor.stopAndConfirm = async (_identity, acceptComplete = false) => {
			observedAcceptComplete = acceptComplete;
			return false;
		};
		const terminal = await runner.run();
		assert.equal(observedAcceptComplete, scenario.expected);
		assert.equal(terminal.nodes.deadline?.status, "stale");
		assert.match(terminal.nodes.deadline?.error ?? "", /hard-deadline stop could not be confirmed/);
	}
});

test("runner rejects a symlink output artifact", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-output-symlink-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "output-symlink", goal: "output", workspace: "shadow", nodes: [
		{ taskId: "output", agent: "researcher", task: "SYMLINK_OUTPUT", outputArtifact: "output.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(terminal.status, "failed");
	assert.match(terminal.nodes.output?.error ?? "", /regular file/);
});

test("stop during deterministic validation prevents source apply", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-stop-validation-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "before\n");
	await writeFile(join(cwd, "wait.mjs"), "setTimeout(() => {}, 10_000);\n");
	const localConfig = { ...config, runsDir: runs, validationTimeoutMs: 20_000 };
	const graph = compileGraph({ schemaVersion: 1, graphId: "stop-validation", goal: "stop", workspace: "shadow", nodes: [{
		taskId: "write", agent: "code-implementer", task: "LOCAL_WRITE", outputArtifact: "result.md", sideEffect: "local_write",
		readScope: [{ kind: "file", path: "wait.mjs" }], writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["node wait.mjs"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const runner = new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig);
	const running = runner.run();
	const deadline = Date.now() + 3_000;
	while ((await store.loadSnapshot()).nodes.write?.status !== "verifying" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
	runner.stop();
	const terminal = await running;
	assert.equal(terminal.status, "stopped");
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "before\n");
});

test("post-commit finalization failure resumes the same attempt without another child", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-commit-recovery-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "before\n");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "commit-recovery", goal: "recover", workspace: "shadow", nodes: [{
		taskId: "write", agent: "code-implementer", task: "LOCAL_WRITE", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"], retryPolicy: { maxAttempts: 2 },
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new FailOnceManifestStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new FakeSubagents();
	const first = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(first.status, "needs_attention");
	assert.equal(first.nodes.write?.status, "stale");
	assert.ok(first.nodes.write?.attempts[0]?.writesCommittedAt);
	assert.equal(await readFile(join(cwd, "target.md"), "utf8"), "after\n");
	first.nodes.write!.status = "verifying";
	first.nodes.write!.attempts[0]!.status = "verifying";
	first.status = "queued";
	const releaseResumePreparation = await store.acquireSupervisor("resume-preparation");
	await store.saveSnapshot(first);
	await releaseResumePreparation();
	const second = await new GraphRunner(graph, first, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(second.status, "complete");
	assert.equal(second.nodes.write?.attempt, 1);
	assert.equal(bus.starts.length, 1);
});

test("stop during a multi-file source commit rolls back partial work", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-stop-commit-"));
	const runs = join(cwd, "runs");
	await mkdir(join(cwd, "data"));
	for (let index = 0; index < 250; index += 1) await writeFile(join(cwd, "data", `file-${index}.txt`), `before-${index}\n`);
	const localConfig = { ...config, runsDir: runs, validationTimeoutMs: 20_000 };
	const graph = compileGraph({ schemaVersion: 1, graphId: "stop-commit", goal: "commit", workspace: "shadow", nodes: [{
		taskId: "write", agent: "code-implementer", task: "LOCAL_WRITE_MANY", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "tree", path: "data" }], atomic: true, scopeJustification: "Exercise an atomic multi-file commit.", validationCommands: ["test -f data/file-0.txt"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const runner = new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig);
	const running = runner.run();
	const planPath = store.path("nodes", "write", "attempt-1", "apply-plan.json");
	const deadline = Date.now() + 5_000;
	let sawApplying = false;
	while (Date.now() < deadline) {
		try {
			const plan = JSON.parse(await readFile(planPath, "utf8"));
			if (plan.status === "applying") { sawApplying = true; break; }
		} catch { /* plan not created yet */ }
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.equal(sawApplying, true);
	runner.stop();
	const terminal = await running;
	assert.equal(terminal.nodes.write?.status, "stopped");
	assert.equal(terminal.status, "stopped");
	for (let index = 0; index < 250; index += 1) assert.equal(await readFile(join(cwd, "data", `file-${index}.txt`), "utf8"), `before-${index}\n`);
});

test("notification failure cannot overwrite a completed graph", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-notification-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "notification", goal: "notify", workspace: "shadow", nodes: [
		{ taskId: "done", agent: "researcher", task: "done", outputArtifact: "done.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const terminal = await new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), localConfig, () => { throw new Error("notify failed"); }).run();
	assert.equal(terminal.status, "complete");
	assert.equal((await store.loadSnapshot()).status, "complete");
	assert.match(await readFile(store.path("events.jsonl"), "utf8"), /graph\.notification_failed/);
});

test("runner reloads the authoritative snapshot after acquiring supervision", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-takeover-reload-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "takeover-reload", goal: "reload", nodes: [
		{ taskId: "node", agent: "researcher", task: "must not spawn", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const persisted = initialSnapshot(graph, cwd, "session");
	const stale = structuredClone(persisted);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, persisted);
	persisted.status = "blocked";
	persisted.nodes.node!.status = "blocked";
	await store.saveSnapshot(persisted);
	const bus = new FakeSubagents();
	const result = await new GraphRunner(graph, stale, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(result.status, "blocked");
	assert.equal(bus.starts.length, 0);
});

test("durable stop is honored before any new child dispatch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-durable-stop-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "durable-stop", goal: "stop", nodes: [
		{ taskId: "node", agent: "researcher", task: "must not spawn", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	await store.requestControl("stop");
	const bus = new FakeSubagents();
	const result = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(result.status, "stopped");
	assert.equal(bus.starts.length, 0);
	assert.equal(await store.readDesiredState(), "stopped");
});

test("recovered dispatch with incomplete identity cannot create a replacement attempt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-ambiguous-dispatch-"));
	const runs = join(cwd, "runs");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "ambiguous-dispatch", goal: "recover", nodes: [
		{ taskId: "node", agent: "researcher", task: "must not spawn", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.node = { taskId: "node", status: "dispatch_unknown", attempt: 1, attempts: [{ attempt: 1, status: "dispatch_unknown", sessionDir: join(attemptRoot, "session") }] };
	await store.saveSnapshot(snapshot);
	const bus = new FakeSubagents();
	const result = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(result.status, "needs_attention");
	assert.equal(result.nodes.node?.status, "stale");
	assert.equal(result.nodes.node?.attempt, 1);
	assert.equal(bus.starts.length, 0);
});

test("durable stop rolls back an interrupted apply without dispatching a child", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-stop-recover-apply-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "first.md"), "first-before\n");
	await writeFile(join(cwd, "second.md"), "second-before\n");
	const localConfig = { ...config, runsDir: runs };
	const graph = compileGraph({ schemaVersion: 1, graphId: "stop-recover-apply", goal: "recover", workspace: "shadow", nodes: [{
		taskId: "write", agent: "code-implementer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "first.md" }, { kind: "file", path: "second.md" }], validationCommands: ["test -f first.md"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "write", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir: attemptRoot, strategy: "shadow" });
	await writeFile(join(workspace.cwd, "first.md"), "first-after\n");
	await writeFile(join(workspace.cwd, "second.md"), "second-after\n");
	await workspace.apply();
	const planPath = join(attemptRoot, "apply-plan.json");
	const plan = JSON.parse(await readFile(planPath, "utf8"));
	plan.status = "applying";
	await writeFile(planPath, JSON.stringify(plan));
	await writeFile(join(cwd, "second.md"), "second-before\n");
	await mkdir(join(attemptRoot, "session"), { recursive: true });
	snapshot.status = "running";
	snapshot.nodes.write = { taskId: "write", status: "verifying", attempt: 1, attempts: [{ attempt: 1, status: "verifying", sessionDir: join(attemptRoot, "session"), workspaceDir: workspace.cwd, workspaceKind: "shadow", outputPath: join(attemptRoot, "output", "result.md") }] };
	await store.saveSnapshot(snapshot);
	await store.requestControl("stop");
	const bus = new FakeSubagents();
	const result = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), localConfig).run();
	assert.equal(result.status, "stopped");
	assert.equal(result.nodes.write?.status, "stopped");
	assert.equal(await readFile(join(cwd, "first.md"), "utf8"), "first-before\n");
	assert.equal(await readFile(join(cwd, "second.md"), "utf8"), "second-before\n");
	assert.equal(JSON.parse(await readFile(planPath, "utf8")).status, "rolled_back");
	assert.equal(bus.starts.length, 0);
});

test("resource-wait retry preserves an existing attempt instead of authorizing a new one", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-resource-wait-existing-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "before\n");
	const graph = compileGraph({ schemaVersion: 1, graphId: "resource-wait-existing", goal: "wait", nodes: [{
		taskId: "write", agent: "code-implementer", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], retryPolicy: { maxAttempts: 1 }, validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "write", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.write = {
		taskId: "write",
		status: "resource_wait",
		attempt: 1,
		nextRetryAt: 0,
		attempts: [{ attempt: 1, status: "running", sessionDir: join(attemptRoot, "session") }],
	};
	await store.saveSnapshot(snapshot);
	const runner = new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), { ...config, runsDir: runs });
	await (runner as unknown as { reconcile(): Promise<void> }).reconcile();
	assert.equal(snapshot.nodes.write?.status, "running");
	assert.equal(snapshot.nodes.write?.attempts.length, 1);
	assert.equal(snapshot.nodes.write?.attempt, 1);
});

test("resource-wait before the first attempt remains observable without an implicit deadline", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-resource-wait-before-attempt-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "resource-wait-before-attempt",
		goal: "wait",
		nodes: [{
			taskId: "write",
			agent: "code-implementer",
			task: "write",
			outputArtifact: "result.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "target.md" }],
			timeoutMs: 1_000,
			validationCommands: ["test -f target.md"],
		}],
	} as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.status = "running";
	snapshot.nodes.write!.resourceWaitStartedAt = Date.now() - 2_000;
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const runner = new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), { ...config, runsDir: runs });
	await (runner as unknown as { handleResult(taskId: string, result: { status: "resource_wait"; error: string }): Promise<void> }).handleResult("write", {
		status: "resource_wait",
		error: "busy",
	});
	assert.equal(snapshot.nodes.write?.status, "resource_wait");
	assert.equal(snapshot.nodes.write?.attempt, 0);
	assert.equal(snapshot.nodes.write?.resourceWaitStartedAt !== undefined, true);
	assert.equal(snapshot.nodes.write?.nextRetryAt !== undefined, true);
	assert.equal((await store.loadSnapshot()).nodes.write?.status, "resource_wait");
});

test("resource-wait before a retry preserves the prior terminal attempt without blocking", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-resource-wait-retry-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "resource-wait-retry",
		goal: "wait before retry",
		nodes: [{
			taskId: "write",
			agent: "code-implementer",
			task: "write",
			outputArtifact: "result.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "target.md" }],
			timeoutMs: 1_000,
			retryPolicy: { maxAttempts: 2 },
			validationCommands: ["test -f target.md"],
		}],
	} as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const attemptRoot = join(runs, graph.graphId, "nodes", "write", "attempt-1");
	snapshot.status = "running";
	snapshot.nodes.write = {
		taskId: "write",
		status: "retry_wait",
		attempt: 1,
		resourceWaitStartedAt: Date.now() - 2_000,
		attempts: [{
			attempt: 1,
			status: "failed",
			sessionDir: join(attemptRoot, "session"),
			endedAt: new Date().toISOString(),
			error: "first attempt failed",
		}],
	};
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const runner = new GraphRunner(graph, snapshot, store, new FakeSubagents(), new LeaseRegistry(join(runs, "leases.json")), { ...config, runsDir: runs });
	await (runner as unknown as { handleResult(taskId: string, result: { status: "resource_wait"; error: string }): Promise<void> }).handleResult("write", {
		status: "resource_wait",
		error: "busy",
	});
	assert.equal(snapshot.nodes.write?.status, "resource_wait");
	assert.equal(snapshot.nodes.write?.attempts[0]?.status, "failed");
	assert.equal((await store.loadSnapshot()).nodes.write?.attempts[0]?.status, "failed");
});
