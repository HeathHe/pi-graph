import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { liveClaims, processIdentityForPid } from "../src/claims.ts";
import { compileGraph } from "../src/compile.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import type { GraphSpec } from "../src/types.ts";

test("journal sequence remains monotonic after reopening store", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-"));
	const graph = compileGraph({ schemaVersion: 1, graphId: "journal", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	const store = new GraphStore(root, graph.graphId);
	await store.initialize(graph, initialSnapshot(graph, root));
	await store.event("one");
	await new GraphStore(root, graph.graphId).event("two");
	const events = (await readFile(store.path("events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { seq: number });
	assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
});

test("cross-instance leases reject overlapping trees and release cleanly", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lease-"));
	const file = join(root, "leases.json");
	const first = new LeaseRegistry(file);
	const second = new LeaseRegistry(file);
	const release = await first.acquire({ graphId: "g1", taskId: "a", epoch: "e1", scopes: [{ kind: "tree", path: join(root, "docs") }] });
	assert.ok(release);
	assert.equal(await second.acquire({ graphId: "g2", taskId: "b", epoch: "e2", scopes: [{ kind: "file", path: join(root, "docs", "a.md") }] }), null);
	await release();
	assert.ok(await second.acquire({ graphId: "g2", taskId: "b", epoch: "e2", scopes: [{ kind: "file", path: join(root, "docs", "a.md") }] }));
});

test("the same graph node cannot acquire its write lease twice", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lease-duplicate-"));
	const registry = new LeaseRegistry(join(root, "leases.json"));
	const record = { graphId: "g", taskId: "a", epoch: "e", scopes: [{ kind: "file" as const, path: join(root, "target.md") }] };
	const release = await registry.acquire(record);
	assert.ok(release);
	assert.equal(await registry.acquire(record), null);
	await release();
});

test("concurrent overlapping lease contenders elect exactly one holder", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lease-race-"));
	const file = join(root, "leases.json");
	const results = await Promise.all(Array.from({ length: 20 }, (_, index) => new LeaseRegistry(file).acquire({ graphId: `g${index}`, taskId: "write", epoch: `e${index}`, scopes: [{ kind: "tree", path: join(root, "shared") }] })));
	assert.equal(results.filter(Boolean).length, 1);
	await Promise.all(results.filter((release): release is () => Promise<void> => Boolean(release)).map((release) => release()));
});

test("claim registry removes malformed metadata and reclaims an orphan claim", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lease-recovery-"));
	const file = join(root, "leases.json");
	const claims = `${file}.claims`;
	const scopes = [{ kind: "file" as const, path: join(root, "target.md") }];
	await mkdir(claims);
	await writeFile(join(claims, "corrupt.json"), "not-json");
	await writeFile(join(claims, `${process.pid}-${randomUUID()}.json`), "not-json");
	const releaseCorrupt = await new LeaseRegistry(file).acquire({ graphId: "g", taskId: "a", epoch: "e", scopes });
	assert.ok(releaseCorrupt);
	await releaseCorrupt();
	await assert.rejects(lstat(join(claims, "corrupt.json")), /ENOENT/);
	assert.deepEqual((await readdir(claims)).filter((name) => name.startsWith(`${process.pid}-`)), []);
	await writeFile(join(claims, "corrupt.json"), JSON.stringify({ pid: 99999999, token: "dead", startedNs: "1", state: "held", payload: { graphId: "old", taskId: "old", epoch: "old", scopes: [] } }));
	const abandonedTemporary = join(claims, `orphan.json.99999999.${randomUUID()}.tmp`);
	await writeFile(abandonedTemporary, "{partial");
	const releaseOrphan = await new LeaseRegistry(file).acquire({ graphId: "g", taskId: "a", epoch: "e", scopes });
	assert.ok(releaseOrphan);
	await releaseOrphan();
	await assert.rejects(lstat(abandonedTemporary), /ENOENT/);
});

test("claim registry rejects a reused pid and expires abandoned temporary writes", async (t) => {
	const ownerIdentity = await processIdentityForPid(process.pid);
	if (!ownerIdentity) {
		t.skip("Process start identity is unavailable on this platform.");
		return;
	}
	const root = await mkdtemp(join(tmpdir(), "pi-graph-claim-identity-"));
	const claims = join(root, "claims");
	await mkdir(claims);
	const token = randomUUID();
	const staleClaim = join(claims, `${process.pid}-${token}.json`);
	await writeFile(staleClaim, JSON.stringify({
		pid: process.pid,
		token,
		startedNs: process.hrtime.bigint().toString(),
		ownerIdentity: `${ownerIdentity}:different-process`,
		state: "held",
		payload: { purpose: "pid-reuse-test" },
	}));
	assert.deepEqual(await liveClaims(claims), []);
	await assert.rejects(lstat(staleClaim), /ENOENT/);

	const abandonedTemporary = join(claims, `pending.json.${process.pid}.${randomUUID()}.tmp`);
	await writeFile(abandonedTemporary, "{partial");
	const stale = new Date(Date.now() - 6 * 60_000);
	await utimes(abandonedTemporary, stale, stale);
	assert.deepEqual(await liveClaims(claims), []);
	await assert.rejects(lstat(abandonedTemporary), /ENOENT/);
});

test("concurrent supervisor contenders elect exactly one holder", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-supervisor-race-"));
	const contenders = Array.from({ length: 20 }, (_, index) => new GraphStore(root, "same").acquireSupervisor(`e${index}`));
	const results = await Promise.allSettled(contenders);
	const holders = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
	assert.equal(holders.length, 1);
	await holders[0]!.value();
});

test("Graph lock mutation gates do not serialize unrelated Graph ids", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-keyed-gate-"));
	const contenders = 200;
	let entered = 0;
	let resolveAllEntered!: () => void;
	let releaseActions!: () => void;
	const allEntered = new Promise<void>((resolve) => { resolveAllEntered = resolve; });
	const actionRelease = new Promise<void>((resolve) => { releaseActions = resolve; });
	const gates = Array.from({ length: contenders }, (_, index) => {
		const graphId = `parallel-${index}`;
		return GraphStore.withGraphLockMutationGate(root, graphId, "parallel-test", async () => {
			entered += 1;
			if (entered === contenders) resolveAllEntered();
			await actionRelease;
		});
	});
	const reachedAll = await Promise.race([
		allEntered.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
	]);
	const names = await readdir(join(root, ".control", "graph-lock-gate", "claims"));
	releaseActions();
	await Promise.all(gates);
	assert.equal(reachedAll, true);
	assert.equal(entered, contenders);
	assert.equal(names.length, contenders);
	assert.ok(names.every((name) => /^k-[a-f0-9]{16}\.[1-9][0-9]*-[a-f0-9-]+\.json$/i.test(name)));
});

test("invalid keyed gate claims fail closed as global contenders", async (t) => {
	for (const invalidGraphId of [123, "../invalid"]) {
		await t.test(String(invalidGraphId), async () => {
			const root = await mkdtemp(join(tmpdir(), "pi-graph-invalid-keyed-gate-"));
			const claims = join(root, ".control", "graph-lock-gate", "claims");
			await mkdir(claims, { recursive: true });
			const token = randomUUID();
			const invalidClaim = join(claims, `${process.pid}-${token}.json`);
			await writeFile(invalidClaim, JSON.stringify({
				pid: process.pid,
				token,
				startedNs: process.hrtime.bigint().toString(),
				state: "held",
				payload: { purpose: "injected-invalid-key", graphId: invalidGraphId },
			}));
			let entered = false;
			const contender = GraphStore.withGraphLockMutationGate(root, "target", "invalid-key-test", async () => {
				entered = true;
			});
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.equal(entered, false);
			await rm(invalidClaim);
			await contender;
			assert.equal(entered, true);
		});
	}
});

test("released Supervisor cannot write even before another generation is acquired", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-supervisor-release-"));
	const graph = compileGraph({ schemaVersion: 1, graphId: "released", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	const store = new GraphStore(root, graph.graphId);
	await store.initialize(graph, initialSnapshot(graph, root));
	const release = await store.acquireSupervisor("owner");
	await release();
	await assert.rejects(store.saveSnapshot(await store.loadSnapshot()), /no longer holds its Supervisor claim/);
});

test("graph store rejects traversal ids", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-id-"));
	assert.throws(() => new GraphStore(root, "../escape"), /graphId/);
});

test("graph store initialization independently rejects scopes into its runs root", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-store-protected-runs-"));
	const runsRoot = join(cwd, "graph-runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "protected-runs",
		goal: "read runtime state",
		nodes: [{ taskId: "reader", agent: "researcher", task: "read another run", outputArtifact: "result.md", sideEffect: "none", readScope: [{ kind: "tree", path: "graph-runs/.control" }] }],
	} as GraphSpec, cwd, 20, 2);
	const store = new GraphStore(runsRoot, graph.graphId);
	await assert.rejects(store.initialize(graph, initialSnapshot(graph, cwd, "session", 2)), /readScope intersects protected Graph runs root/);
});

test("graph store fails closed on a corrupted snapshot", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-corrupt-"));
	const graph = compileGraph({ schemaVersion: 1, graphId: "corrupt", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	const store = new GraphStore(root, graph.graphId);
	await store.initialize(graph, initialSnapshot(graph, root));
	await writeFile(store.path("snapshot.json"), JSON.stringify({ schemaVersion: 1, graphId: "other", status: "running" }));
	await assert.rejects(() => store.loadSnapshot(), /Invalid graph snapshot/);
});

test("graph listing ignores runtime control directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-list-"));
	await mkdir(join(root, ".control", "leases.claims"), { recursive: true });
	const graph = compileGraph({ schemaVersion: 1, graphId: "listed", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	await new GraphStore(root, graph.graphId).initialize(graph, initialSnapshot(graph, root));
	assert.deepEqual(await GraphStore.list(root), ["listed"]);
});

test("stop intent remains durable after its edge-triggered control request is consumed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-stop-intent-"));
	const graph = compileGraph({ schemaVersion: 1, graphId: "durable-stop", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	const store = new GraphStore(root, "durable-stop");
	await store.initialize(graph, initialSnapshot(graph, root));
	await store.requestControl("stop");
	assert.equal(await store.readDesiredState(), "stopped");
	assert.equal(await store.consumeControl("stop"), true);
	assert.equal(await store.consumeControl("stop"), false);
	assert.equal(await store.readDesiredState(), "stopped");
});

test("snapshot validation rejects task traversal but accepts bounded legacy terminal outputs", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-store-legacy-"));
	const graph = compileGraph({ schemaVersion: 1, graphId: "legacy", goal: "x", nodes: [{ taskId: "a", agent: "x", task: "x", outputArtifact: "a.md", sideEffect: "none" }] } as GraphSpec, root);
	const store = new GraphStore(root, graph.graphId);
	const snapshot = initialSnapshot(graph, root);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "a", "attempt-1");
	const legacyOutput = store.path("artifacts", "a.md");
	const terminal = initialSnapshot(graph, root);
	terminal.status = "complete";
	terminal.nodes.a = { taskId: "a", status: "accepted", attempt: 1, attempts: [{ attempt: 1, status: "accepted", sessionDir: join(attemptRoot, "session"), outputPath: legacyOutput }] };
	await store.saveSnapshot(terminal);
	assert.equal((await store.loadSnapshot()).nodes.a?.attempts[0]?.outputPath, legacyOutput);

	const active = structuredClone(terminal);
	active.status = "running";
	active.nodes.a!.status = "running";
	active.nodes.a!.attempts[0]!.status = "running";
	await assert.rejects(() => store.saveSnapshot(active), /attempt path/);

	const raw = structuredClone(terminal) as any;
	raw.nodes["../escape"] = { ...raw.nodes.a, taskId: "../escape" };
	delete raw.nodes.a;
	await writeFile(store.path("snapshot.json"), JSON.stringify(raw));
	await assert.rejects(() => store.loadSnapshot(), /graphId/);
});
