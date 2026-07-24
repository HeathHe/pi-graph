import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createClaim, markClaimHeld, releaseClaim } from "../src/claims.ts";
import { compileGraph } from "../src/compile.ts";
import { GraphStore } from "../src/store.ts";
import { doctorGraphRuns } from "../src/doctor.ts";
import type { GraphSnapshotV2 } from "../src/types.ts";

function spec(graphId: string) {
	return {
		schemaVersion: 1 as const,
		graphId,
		goal: "snapshot fixture",
		nodes: [{
			taskId: "read",
			agent: "scout",
			task: "inspect",
			outputArtifact: "read.md",
			sideEffect: "local_read" as const,
		}],
	};
}

test("snapshot v2 persists safe tokens and reconstructs runtime paths", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v2-"));
	const graph = compileGraph(spec("v2-token"), root);
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	const now = new Date().toISOString();
	const snapshot: GraphSnapshotV2 = {
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		lifecycleRevision: 0,
		fencingGeneration: 0,
		graphId: graph.graphId,
		status: "running",
		goal: graph.goal,
		sourceCwd: root,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: {
			read: {
				taskId: "read",
				status: "running",
				attempt: 1,
				attempts: [{
					attempt: 1,
					status: "running",
					sessionDir: store.path("nodes", "read", "attempt-1", "session"),
					workspaceDir: store.path("nodes", "read", "attempt-1", "workspace"),
					outputPath: store.path("nodes", "read", "attempt-1", "output", "read.md"),
					asyncId: "child-1",
					asyncDir: join((await import("../src/rpc.ts")).subagentAsyncRoot(), "child-1"),
				}],
			},
		},
	};
	await store.initialize(graph, snapshot);
	const raw = JSON.parse(await readFile(store.path("snapshot.json"), "utf8")) as Record<string, any>;
	assert.equal(raw.nodes.read.attempts[0].sessionDir, undefined);
	assert.equal(raw.nodes.read.attempts[0].asyncDir, undefined);
	assert.equal(raw.nodes.read.attempts[0].paths.session, "nodes/read/attempt-1/session");
	const loaded = await store.loadSnapshot();
	assert.equal(loaded.schemaVersion, 2);
	assert.equal(loaded.nodes.read?.attempts[0]?.sessionDir, snapshot.nodes.read?.attempts[0]?.sessionDir);
});

test("snapshot v2 rejects traversal tokens and terminalAt mutation", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v2-bad-"));
	const graph = compileGraph(spec("v2-bad"), root);
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	const now = new Date().toISOString();
	const snapshot: GraphSnapshotV2 = {
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		lifecycleRevision: 0,
		fencingGeneration: 0,
		graphId: graph.graphId,
		status: "complete",
		goal: graph.goal,
		sourceCwd: root,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: {
			read: {
				taskId: "read",
				status: "accepted",
				attempt: 1,
				attempts: [{
					attempt: 1,
					status: "accepted",
					sessionDir: store.path("nodes", "read", "attempt-1", "session"),
					workspaceDir: store.path("nodes", "read", "attempt-1", "workspace"),
					outputPath: store.path("nodes", "read", "attempt-1", "output", "read.md"),
				}],
			},
		},
	};
	await store.initialize(graph, snapshot);
	await store.saveSnapshot(snapshot);
	const terminalAt = snapshot.terminalAt;
	snapshot.terminalAt = new Date(Date.now() + 10_000).toISOString();
	await assert.rejects(store.saveSnapshot(snapshot), /terminalAt is immutable/);
	snapshot.terminalAt = terminalAt;
	const raw = JSON.parse(await readFile(store.path("snapshot.json"), "utf8"));
	raw.nodes.read = { taskId: "read", status: "running", attempt: 1, attempts: [{ attempt: 1, status: "running", paths: { session: "../escape" } }] };
	raw.status = "running";
	delete raw.terminalAt;
	await writeFile(store.path("snapshot.json"), JSON.stringify(raw));
	await assert.rejects(store.loadSnapshot(), /unsafe path token/);
});

test("doctor is read-only and protects corrupt runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-doctor-"));
	const runs = join(root, "runs");
	const graph = compileGraph(spec("healthy"), root);
	const store = new GraphStore(runs, graph.graphId);
	const now = new Date().toISOString();
	await store.initialize(graph, {
		schemaVersion: 1,
		graphId: graph.graphId,
		status: "queued",
		goal: graph.goal,
		sourceCwd: root,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: { read: { taskId: "read", status: "pending", attempt: 0, attempts: [] } },
	});
	await mkdir(join(runs, "corrupt"), { recursive: true });
	await writeFile(join(runs, "corrupt", "graph.json"), "{}");
	await writeFile(join(runs, "corrupt", "snapshot.json"), "{broken");
	const before = await readFile(join(runs, "corrupt", "snapshot.json"), "utf8");
	const report = await doctorGraphRuns(runs);
	assert.equal(report.ok, 1);
	assert.equal(report.protected, 1);
	assert.deepEqual(report.runs.map((run) => run.graphId), ["corrupt", "healthy"]);
	assert.equal(await readFile(join(runs, "corrupt", "snapshot.json"), "utf8"), before);
});

test("doctor protects v2 runs whose authority evidence is missing", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-doctor-v2-"));
	const runs = join(root, "runs");
	const graph = compileGraph(spec("missing-authority"), root);
	const store = new GraphStore(runs, graph.graphId);
	const now = new Date().toISOString();
	await store.initialize(graph, {
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
	});
	await rm(store.path("authorization.json"));
	const before = await readFile(store.path("snapshot.json"), "utf8");
	const report = await doctorGraphRuns(runs);
	assert.equal(report.ok, 0);
	assert.equal(report.protected, 1);
	assert.match(report.runs[0]?.issues[0] ?? "", /Invalid authorization/);
	assert.equal(await readFile(store.path("snapshot.json"), "utf8"), before);
});

test("doctor ignores live transaction claims and reports malformed source reservations", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-doctor-control-"));
	const runs = join(root, "runs");
	const claims = join(runs, ".control", "retention-lock", "claims");
	const active = await createClaim(claims, { purpose: "doctor-live-test" });
	await markClaimHeld(active);
	const whileActive = await doctorGraphRuns(runs);
	assert.equal(whileActive.controlProtected.some((entry) => entry.path.includes("retention-lock/claims")), false);
	await releaseClaim(active);

	const reservation = join(runs, ".control", "source-reservations", "run", "write", "attempt-1.json");
	await mkdir(join(reservation, ".."), { recursive: true });
	await writeFile(reservation, "{broken");
	const malformed = await doctorGraphRuns(runs);
	assert.ok(malformed.controlProtected.some((entry) => entry.path.endsWith("source-reservations/run/write/attempt-1.json") && entry.reason.includes("malformed source reservation")));
});

test("doctor does not report a live pre-publication Graph lock as orphaned", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-doctor-live-initialization-"));
	const runs = join(root, "runs");
	const store = new GraphStore(runs, "initializing");
	const release = await store.acquireSupervisor("initializing");
	const active = await doctorGraphRuns(runs);
	assert.equal(active.controlProtected.some((entry) => entry.path === ".control/graph-locks/initializing" && entry.reason.includes("no published Graph")), false);
	await release();
	const orphaned = await doctorGraphRuns(runs);
	assert.equal(orphaned.controlProtected.some((entry) => entry.path === ".control/graph-locks/initializing" && entry.reason.includes("no published Graph")), true);
});
