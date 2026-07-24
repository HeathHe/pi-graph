import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { processIdentityForPid } from "../src/claims.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphStore } from "../src/store.ts";
import { garbageCollectSourceReservations, SourceReservationRegistry } from "../src/reservations.ts";
import { GraphRunner } from "../src/runner.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { SubagentRpcClient, subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { NodeExecutor } from "../src/executor.ts";
import type { GraphConfig, GraphSnapshotV2 } from "../src/types.ts";
import { prepareWorkspace } from "../src/workspace.ts";
import { canonicalDigest } from "../src/authority.ts";
import { loadValidatedRun } from "../src/reconciler.ts";

function graphAt(root: string, graphId: string) {
	return compileGraph({
		schemaVersion: 1,
		graphId,
		goal: "v2 foundation",
		nodes: [{
			taskId: "write",
			agent: "worker",
			task: "write",
			outputArtifact: "out.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file" as const, path: "target.md" }],
			validationCommands: ["git status --porcelain"],
		}],
	}, root);
}

function snapshot(graph: ReturnType<typeof graphAt>, sourceCwd: string): GraphSnapshotV2 {
	const now = new Date().toISOString();
	return {
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		lifecycleRevision: 0,
		fencingGeneration: 0,
		graphId: graph.graphId,
		status: "queued",
		goal: graph.goal,
		sourceCwd,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: { write: { taskId: "write", status: "pending", attempt: 0, attempts: [] } },
	};
}

test("v2 authorization is authoritative and graph projection tampering is rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-auth-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "authority");
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	await store.initialize(graph, snapshot(graph, root));
	const authorization = JSON.parse(await readFile(store.path("authorization.json"), "utf8"));
	assert.equal(authorization.runInstanceId, (await store.loadSnapshot() as GraphSnapshotV2).runInstanceId);
	const projection = JSON.parse(await readFile(store.path("graph.json"), "utf8"));
	projection.goal = "tampered";
	await writeFile(store.path("graph.json"), JSON.stringify(projection));
	await assert.rejects(store.loadGraph(), /authorization/);
});

test("lowering the admission spawn budget does not invalidate an existing run", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-historical-budget-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "historical-budget",
		goal: "historical budget",
		nodes: [{
			taskId: "write",
			agent: "worker",
			task: "write",
			outputArtifact: "out.md",
			sideEffect: "local_write",
			writeScope: [{ kind: "file", path: "target.md" }],
			retryPolicy: { maxAttempts: 2 },
			validationCommands: ["git status --porcelain"],
		}],
	}, root, 2, 2);
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	await store.initialize(graph, snapshot(graph, root));
	assert.equal((await loadValidatedRun(store, 1)).graph.graphId, graph.graphId);
});

test("external graph lock fencing rejects a stale writer", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-fence-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "fenced");
	const first = new GraphStore(join(root, "runs"), graph.graphId);
	const state = snapshot(graph, root);
	await first.initialize(graph, state);
	const releaseFirst = await first.acquireSupervisor("first");
	await first.saveSnapshot(state);
	await releaseFirst();
	const second = new GraphStore(join(root, "runs"), graph.graphId);
	const releaseSecond = await second.acquireSupervisor("second");
	const latest = await second.loadSnapshot();
	await second.saveSnapshot(latest);
	await assert.rejects(first.saveSnapshot(state), /Stale graph Supervisor fence|no longer holds its Supervisor claim/);
	await releaseSecond();
});

test("a GraphStore without a claim cannot write while another Supervisor is active", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-fence-unclaimed-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "fence-unclaimed");
	const runs = join(root, "runs");
	const owner = new GraphStore(runs, graph.graphId);
	const state = snapshot(graph, root);
	await owner.initialize(graph, state);
	const release = await owner.acquireSupervisor("owner");
	const outsider = new GraphStore(runs, graph.graphId);
	const forged = await outsider.loadSnapshot();
	forged.error = "forged";
	await assert.rejects(outsider.saveSnapshot(forged), /already supervised/);
	assert.notEqual((await owner.loadSnapshot()).error, "forged");
	await release();
});

test("Supervisor release waits for an in-flight snapshot write before a successor can commit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-fence-barrier-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "fence-barrier");
	const runs = join(root, "runs");
	const first = new GraphStore(runs, graph.graphId);
	const state = snapshot(graph, root);
	await first.initialize(graph, state);
	const releaseFirst = await first.acquireSupervisor("first");
	state.error = "x".repeat(8 * 1024 * 1024);
	const oldWrite = first.saveSnapshot(state);
	const releasing = releaseFirst();
	await Promise.all([oldWrite, releasing]);
	const second = new GraphStore(runs, graph.graphId);
	const releaseSecond = await second.acquireSupervisor("second");
	const latest = await second.loadSnapshot();
	latest.error = "successor";
	await second.saveSnapshot(latest);
	await releaseSecond();
	assert.equal((await second.loadSnapshot()).error, "successor");
});

test("Graph Supervisor claims reject a symbolic-link control directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lock-symlink-"));
	const runs = join(root, "runs");
	const external = join(root, "external-locks");
	await mkdir(join(runs, ".control"), { recursive: true });
	await mkdir(external);
	await symlink(external, join(runs, ".control", "graph-locks"));
	const graph = graphAt(root, "lock-symlink");
	const store = new GraphStore(runs, graph.graphId);
	await assert.rejects(store.acquireSupervisor("blocked"), /symbolic link/);
});

test("GraphStore initialization fails before graph publication when its lock path is unsafe", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-initialize-lock-link-"));
	const runs = join(root, "runs");
	const external = join(root, "external-locks");
	await mkdir(join(runs, ".control"), { recursive: true });
	await mkdir(external);
	await symlink(external, join(runs, ".control", "graph-locks"));
	const graph = graphAt(root, "initialize-lock-link");
	const store = new GraphStore(runs, graph.graphId);
	await assert.rejects(store.initialize(graph, snapshot(graph, root)), /symbolic link/);
	await assert.rejects(lstat(store.root), /ENOENT/);
	await rm(join(runs, ".control", "graph-locks"));
	await store.initialize(graph, snapshot(graph, root));
	assert.equal((await store.loadSnapshot()).graphId, graph.graphId);
});

test("GraphStore initialization detects a staging identity swap without overwriting external files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-initialize-swap-"));
	const runs = join(root, "runs");
	const external = join(root, "external");
	const captured = join(root, "captured-staging");
	await mkdir(external);
	for (const name of ["snapshot.json", "authorization.json", "events.jsonl"]) await writeFile(join(external, name), `sentinel:${name}`);
	const graph = graphAt(root, "initialize-swap");
	graph.goal = "x".repeat(8 * 1024 * 1024);
	const state = snapshot(graph, root);
	state.goal = graph.goal;
	const store = new GraphStore(runs, graph.graphId);
	const initializing = store.initialize(graph, state);
	let staging: string | undefined;
	for (let attempt = 0; attempt < 5_000 && !staging; attempt += 1) {
		const found = (await readdir(runs).catch(() => [])).find((name) => name.startsWith(`.initialize-${graph.graphId}-`));
		if (found) staging = join(runs, found);
		else await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
	}
	assert.ok(staging);
	for (let attempt = 0; attempt < 5_000; attempt += 1) {
		try {
			await lstat(join(staging, "graph.json"));
			break;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
		}
	}
	await rename(staging, captured);
	await symlink(external, staging);
	await assert.rejects(initializing, /staging identity changed|EEXIST/);
	for (const name of ["snapshot.json", "authorization.json", "events.jsonl"]) {
		assert.equal(await readFile(join(external, name), "utf8"), `sentinel:${name}`);
	}
	await assert.rejects(lstat(store.root), /ENOENT/);
	await rm(captured, { recursive: true, force: true });
});

test("GraphStore initialization rejects a symbolic-link runs root before writing graph data", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-initialize-runs-link-"));
	const external = join(root, "external-runs");
	const runs = join(root, "runs");
	await mkdir(external);
	await symlink(external, runs);
	const graph = graphAt(root, "initialize-runs-link");
	const store = new GraphStore(runs, graph.graphId);
	await assert.rejects(store.initialize(graph, snapshot(graph, root)), /runs root must be a real directory/i);
	await assert.rejects(lstat(join(external, graph.graphId)), /ENOENT/);
});

test("GraphStore rejects symbolic-link descendants without touching external data", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-descendant-symlink-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "descendant-symlink");
	const runs = join(root, "runs");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot(graph, root));
	const external = join(root, "external");
	await mkdir(external);
	await symlink(external, store.path("nodes"));
	await assert.rejects(store.writeJson("nodes/write/attempt-1/evidence.json", { unsafe: true }), /symbolic link/);
	await assert.rejects(readFile(join(external, "write", "attempt-1", "evidence.json"), "utf8"), /ENOENT/);
});

test("source reservation persists and blocks a different run with an interrupted apply", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-"));
	const control = join(root, ".control");
	const registry = new SourceReservationRegistry(control);
	const attemptDir = join(root, "run-a", "nodes", "write", "attempt-1");
	await mkdir(attemptDir, { recursive: true });
	await writeFile(join(attemptDir, "apply-plan.json"), JSON.stringify({ version: 2, status: "applying" }));
	const scope = [{ kind: "file" as const, path: join(root, "target.md") }];
	const release = await registry.acquire({ runInstanceId: "run-a", graphId: "a", taskId: "write", attempt: 1, supervisorEpoch: "e1", fencingGeneration: 1, scopes: scope, attemptDir });
	assert.ok(release);
	const recordPath = join(control, "source-reservations", "run-a", "write", "attempt-1.json");
	const record = JSON.parse(await readFile(recordPath, "utf8"));
	record.pid = 99999999;
	await writeFile(recordPath, JSON.stringify(record));
	assert.equal(await registry.acquire({ runInstanceId: "run-b", graphId: "b", taskId: "write", attempt: 1, supervisorEpoch: "e2", fencingGeneration: 1, scopes: scope, attemptDir: join(root, "run-b") }), null);
});

test("a live prepared source transaction remains reserved until release", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-prepared-"));
	const control = join(root, ".control");
	const registry = new SourceReservationRegistry(control);
	const attemptDir = join(root, "run-a", "nodes", "write", "attempt-1");
	await mkdir(attemptDir, { recursive: true });
	const scope = [{ kind: "file" as const, path: join(root, "target.md") }];
	const release = await registry.acquire({ runInstanceId: "run-a", graphId: "a", taskId: "write", attempt: 1, supervisorEpoch: "e1", fencingGeneration: 1, scopes: scope, attemptDir });
	assert.ok(release);
	await writeFile(join(attemptDir, "apply-plan.json"), JSON.stringify({ version: 2, status: "prepared" }));
	assert.equal(await registry.acquire({ runInstanceId: "run-b", graphId: "b", taskId: "write", attempt: 1, supervisorEpoch: "e2", fencingGeneration: 1, scopes: scope, attemptDir: join(root, "run-b", "attempt-1") }), null);
	await garbageCollectSourceReservations(control, 0);
	assert.equal(JSON.parse(await readFile(join(control, "source-reservations", "run-a", "write", "attempt-1.json"), "utf8")).state, "held");
	await release();
});

test("a higher fencing generation takes over the same live source reservation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-fence-takeover-"));
	const control = join(root, ".control");
	const registry = new SourceReservationRegistry(control);
	const attemptDir = join(root, "run", "nodes", "write", "attempt-1");
	await mkdir(attemptDir, { recursive: true });
	await writeFile(join(attemptDir, "apply-plan.json"), JSON.stringify({ version: 2, status: "applying" }));
	const input = {
		runInstanceId: "run",
		graphId: "graph",
		taskId: "write",
		attempt: 1,
		supervisorEpoch: "epoch-1",
		fencingGeneration: 1,
		scopes: [{ kind: "file" as const, path: join(root, "target.md") }],
		attemptDir,
	};
	const releaseFirst = await registry.acquire(input);
	assert.ok(releaseFirst);
	const releaseSecond = await registry.acquire({ ...input, supervisorEpoch: "epoch-2", fencingGeneration: 2 });
	assert.ok(releaseSecond);
	const target = join(control, "source-reservations", "run", "write", "attempt-1.json");
	assert.equal(JSON.parse(await readFile(target, "utf8")).fencingGeneration, 2);
	await releaseFirst();
	assert.equal(JSON.parse(await readFile(target, "utf8")).fencingGeneration, 2);
	await writeFile(join(attemptDir, "apply-plan.json"), JSON.stringify({ version: 2, status: "committed" }));
	await releaseSecond();
});

test("concurrent source reservations elect one holder for overlapping scopes", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-race-"));
	const control = join(root, ".control");
	const scope = [{ kind: "file" as const, path: join(root, "target.md") }];
	const results = await Promise.all(["a", "b"].map((id) => new SourceReservationRegistry(control).acquire({
		runInstanceId: `run-${id}`,
		graphId: id,
		taskId: "write",
		attempt: 1,
		supervisorEpoch: `e-${id}`,
		fencingGeneration: 1,
		scopes: scope,
		attemptDir: join(root, `run-${id}`, "attempt-1"),
	})));
	assert.equal(results.filter(Boolean).length, 1);
	await Promise.all(results.filter((release): release is () => Promise<void> => Boolean(release)).map((release) => release()));
});

test("source reservation GC cannot erase a concurrently published holder", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-gc-race-"));
	const control = join(root, ".control");
	const input = {
		runInstanceId: "run",
		graphId: "graph",
		taskId: "write",
		attempt: 1,
		supervisorEpoch: "epoch",
		fencingGeneration: 1,
		scopes: [{ kind: "file" as const, path: join(root, "target.md") }],
		attemptDir: join(root, "run", "attempt-1"),
	};
	const target = join(control, "source-reservations", "run", "write", "attempt-1.json");
	await mkdir(join(target, ".."), { recursive: true });
	const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
	await writeFile(target, JSON.stringify({
		version: 1,
		reservationId: randomUUID(),
		...input,
		pid: process.pid,
		state: "released",
		acquiredAt: old,
		updatedAt: old,
	}));
	const [, release] = await Promise.all([
		garbageCollectSourceReservations(control, 0),
		new SourceReservationRegistry(control).acquire(input),
	]);
	assert.ok(release);
	assert.equal(JSON.parse(await readFile(target, "utf8")).state, "held");
	await release();
});

test("source reservations reject a reused pid without blocking unrelated recovery", async (t) => {
	const ownerIdentity = await processIdentityForPid(process.pid);
	if (!ownerIdentity) {
		t.skip("Process start identity is unavailable on this platform.");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-pid-reuse-"));
	const control = join(root, ".control");
	const registry = new SourceReservationRegistry(control);
	const scope = [{ kind: "file" as const, path: join(root, "target.md") }];
	const firstAttempt = join(root, "run-a", "attempt-1");
	await mkdir(firstAttempt, { recursive: true });
	const firstRelease = await registry.acquire({
		runInstanceId: "run-a",
		graphId: "a",
		taskId: "write",
		attempt: 1,
		supervisorEpoch: "e1",
		fencingGeneration: 1,
		scopes: scope,
		attemptDir: firstAttempt,
	});
	assert.ok(firstRelease);
	const recordPath = join(control, "source-reservations", "run-a", "write", "attempt-1.json");
	const record = JSON.parse(await readFile(recordPath, "utf8"));
	assert.equal(record.ownerIdentity, ownerIdentity);
	record.ownerIdentity = `${ownerIdentity}:different-process`;
	await writeFile(recordPath, JSON.stringify(record));
	const secondRelease = await registry.acquire({
		runInstanceId: "run-b",
		graphId: "b",
		taskId: "write",
		attempt: 1,
		supervisorEpoch: "e2",
		fencingGeneration: 1,
		scopes: scope,
		attemptDir: join(root, "run-b", "attempt-1"),
	});
	assert.ok(secondRelease);
	const historyRoot = join(control, "source-reservations", ".history", "run-a", "write");
	const [historyName] = await readdir(historyRoot);
	assert.equal(JSON.parse(await readFile(join(historyRoot, historyName!), "utf8")).state, "abandoned");
	await secondRelease();
});

test("source reservations reject a symbolic-link managed root", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-symlink-"));
	const control = join(root, ".control");
	const external = join(root, "external");
	await mkdir(control);
	await mkdir(external);
	await writeFile(join(external, "keep.json"), "{}");
	await symlink(external, join(control, "source-reservations"));
	const registry = new SourceReservationRegistry(control);
	await assert.rejects(registry.acquire({
		runInstanceId: "run",
		graphId: "graph",
		taskId: "task",
		attempt: 1,
		supervisorEpoch: "epoch",
		fencingGeneration: 1,
		scopes: [],
		attemptDir: join(root, "attempt"),
	}), /symbolic link/);
	assert.equal(await readFile(join(external, "keep.json"), "utf8"), "{}");
});

test("source reservations reject a symbolic-link record without touching its target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-record-symlink-"));
	const control = join(root, ".control");
	const registry = new SourceReservationRegistry(control);
	const runInstanceId = randomUUID();
	const recordRoot = join(control, "source-reservations", runInstanceId, "write");
	const external = join(root, "external.json");
	await mkdir(recordRoot, { recursive: true });
	await writeFile(external, "{}");
	await symlink(external, join(recordRoot, "attempt-1.json"));
	await assert.rejects(
		registry.acquire({
			runInstanceId,
			graphId: "reservation-record",
			taskId: "write",
			attempt: 1,
			supervisorEpoch: "owner",
			fencingGeneration: 1,
			scopes: [{ kind: "file", path: join(root, "target.md") }],
			attemptDir: join(root, "attempt"),
		}),
		/regular file/,
	);
	assert.equal(await readFile(external, "utf8"), "{}");
});

test("a symbolic-link reservation from another run fails closed instead of hiding a conflict", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-hidden-link-"));
	const control = join(root, ".control");
	const external = join(root, "external-reservation.json");
	const linked = join(control, "source-reservations", "other-run", "write", "attempt-1.json");
	await mkdir(dirname(linked), { recursive: true });
	await writeFile(external, "{}");
	await symlink(external, linked);
	await assert.rejects(
		new SourceReservationRegistry(control).acquire({
			runInstanceId: "new-run",
			graphId: "new-graph",
			taskId: "write",
			attempt: 1,
			supervisorEpoch: "owner",
			fencingGeneration: 1,
			scopes: [{ kind: "file", path: join(root, "target.md") }],
			attemptDir: join(root, "new-run", "attempt-1"),
		}),
		/symbolic link/,
	);
	assert.equal(await readFile(external, "utf8"), "{}");
});

test("a malformed held scope fails closed instead of bypassing overlap detection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-malformed-scope-"));
	const control = join(root, ".control");
	const target = join(control, "source-reservations", "other-run", "write", "attempt-1.json");
	const now = new Date().toISOString();
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, JSON.stringify({
		version: 1,
		reservationId: randomUUID(),
		runInstanceId: "other-run",
		graphId: "other-graph",
		taskId: "write",
		attempt: 1,
		supervisorEpoch: "owner",
		fencingGeneration: 1,
		pid: process.pid,
		scopes: [{ kind: "file", path: 42 }],
		attemptDir: join(root, "other-run", "attempt-1"),
		state: "held",
		acquiredAt: now,
		updatedAt: now,
	}));
	await assert.rejects(
		new SourceReservationRegistry(control).acquire({
			runInstanceId: "new-run",
			graphId: "new-graph",
			taskId: "write",
			attempt: 1,
			supervisorEpoch: "new-owner",
			fencingGeneration: 1,
			scopes: [{ kind: "file", path: join(root, "target.md") }],
			attemptDir: join(root, "new-run", "attempt-1"),
		}),
		/Invalid source reservation scope/,
	);
});

test("source reservation setup failure still releases the in-process write lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-cleanup-"));
	await writeFile(join(root, "target.md"), "before");
	const runs = join(root, "runs");
	const graph = graphAt(root, "reservation-cleanup");
	const state = snapshot(graph, root);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, state);
	const external = join(root, "external");
	await mkdir(external);
	await symlink(external, join(runs, ".control", "source-reservations"));
	class TrackingLeaseRegistry extends LeaseRegistry {
		releases = 0;
		override async acquire(_record: Parameters<LeaseRegistry["acquire"]>[0]): Promise<(() => Promise<void>) | null> {
			return async () => { this.releases += 1; };
		}
	}
	const leases = new TrackingLeaseRegistry(join(runs, ".control", "leases"));
	const bus: EventBus = { on: () => undefined, emit: () => undefined };
	const config = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 50,
		validationTimeoutMs: 1_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
	const executor = new NodeExecutor(
		graph,
		store,
		new SubagentRpcClient(bus, 50),
		bus,
		leases,
		config,
		state.supervisorEpoch,
		state.sessionId,
		{ runInstanceId: state.runInstanceId, fencingGeneration: state.fencingGeneration },
		async () => undefined,
	);
	const result = await executor.execute(graph.nodes[0]!, state.nodes.write!);
	assert.equal(result.status, "failed");
	assert.equal(leases.releases, 1);
});

test("G2 keeps v2 dispatch closed while committing attempt and workspace authority", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v2-gate-"));
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-gated",
		goal: "no dispatch",
		nodes: [{ taskId: "read", agent: "scout", task: "inspect", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, root);
	const now = new Date().toISOString();
	const state: GraphSnapshotV2 = {
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		lifecycleRevision: 0,
		fencingGeneration: 0,
		graphId: graph.graphId,
		status: "queued",
		goal: graph.goal,
		sourceCwd: root,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: { read: { taskId: "read", status: "pending", attempt: 0, attempts: [] } },
	};
	const runs = join(root, "runs");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, state);
	let spawns = 0;
	const bus: EventBus = { on: () => undefined, emit: (_channel, raw) => { if ((raw as { method?: string })?.method === "spawn") spawns += 1; } };
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 50, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: false };
	const terminal = await new GraphRunner(graph, state, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run();
	assert.equal(terminal.status, "needs_attention");
	assert.equal(spawns, 0);
	const attemptAuthority = JSON.parse(await readFile(store.path("nodes", "read", "attempt-1", "attempt.json"), "utf8"));
	assert.equal(attemptAuthority.phase, "terminal");
	assert.equal(attemptAuthority.terminalStatus, "stale");
	assert.equal(JSON.parse(await readFile(store.path("nodes", "read", "attempt-1", "workspace.json"), "utf8")).schemaVersion, 2);
});

test("durable stop synchronizes v2 snapshot and attempt authority", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v2-durable-stop-"));
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-durable-stop",
		goal: "stop",
		nodes: [{ taskId: "read", agent: "scout", task: "inspect", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, root);
	const runs = join(root, "runs");
	const state = snapshot(graph, root);
	state.nodes = { read: { taskId: "read", status: "pending", attempt: 0, attempts: [] } };
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, state);
	const attemptDir = store.path("nodes", "read", "attempt-1");
	await store.ensureManagedSubdirectory("nodes/read/attempt-1", "Test attempt");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow" });
	const attemptNonce = randomUUID();
	const asyncId = `stop-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running" }));
	state.status = "running";
	state.nodes.read = {
		taskId: "read",
		status: "resource_wait",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "running",
			sessionDir: join(attemptDir, "session"),
			workspaceDir: workspace.cwd,
			workspaceKind: workspace.kind,
			asyncId,
			asyncDir,
			outputPath: join(attemptDir, "output", "read.md"),
		}],
	};
	await store.saveSnapshot(state);
	const base = {
		schemaVersion: 2 as const,
		runInstanceId: state.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: state.supervisorEpoch,
		fencingGeneration: state.fencingGeneration,
		updatedAt: new Date().toISOString(),
	};
	await store.writeAttemptRecord("read", 1, { ...base, phase: "prepared" });
	await store.writeWorkspaceRecord("read", 1, {
		schemaVersion: 2,
		runInstanceId: state.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		workspaceKind: workspace.kind,
		contractDigest: canonicalDigest(workspace.contract),
		writeBaseline: workspace.contract.writeBaseline,
		readBaseline: workspace.contract.readBaseline,
		inputBaseline: workspace.contract.inputBaseline,
		createdAt: new Date().toISOString(),
	});
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", requestDigest: "0".repeat(64), updatedAt: new Date().toISOString() });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "running", requestDigest: "0".repeat(64), asyncId, updatedAt: new Date().toISOString() });
	await store.requestControl("stop");
	let stopCalls = 0;
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const bus: EventBus = {
		on: (channel, handler) => {
			const current = handlers.get(channel) ?? new Set();
			current.add(handler);
			handlers.set(channel, current);
			return () => current.delete(handler);
		},
		emit: (channel, data) => {
			for (const handler of handlers.get(channel) ?? []) handler(data);
			if (channel !== "subagents:rpc:v1:request") return;
			const request = data as { requestId: string; method: string };
			if (request.method !== "stop") return;
			stopCalls += 1;
			void (async () => {
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "stopped" }));
				bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { state: "stopping" } });
			})();
		},
	};
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 50, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const terminal = await new GraphRunner(graph, state, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run();
	assert.equal(terminal.status, "stopped");
	assert.equal(stopCalls, 1);
	assert.equal((await store.readAttemptRecord("read", 1)).terminalStatus, "stopped");
	assert.equal((await loadValidatedRun(new GraphStore(runs, graph.graphId), 2)).snapshot.status, "stopped");
	await rm(asyncDir, { recursive: true, force: true });
});
