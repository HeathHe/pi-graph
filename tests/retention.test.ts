import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { compileGraph } from "../src/compile.ts";
import { GraphStore } from "../src/store.ts";
import { initialSnapshot } from "../src/runner.ts";
import {
	compactRun,
	cancelPrunePlan,
	createPrunePlan,
	discardControlQuarantine,
	discardOrphanPurgeStaging,
	discardProtectedTrash,
	executePrunePlan,
	listTrash,
	listTrashInventory,
	purgeTrash,
	restoreTrash,
	runRetentionMaintenance,
	storageReport,
	updateHistoryFlag,
} from "../src/retention.ts";
import type { GraphConfig, GraphSnapshot } from "../src/types.ts";
import { doctorGraphRuns } from "../src/doctor.ts";

async function terminalFixture(root: string, graphId: string) {
	const graph = compileGraph({
		schemaVersion: 1,
		graphId,
		goal: "retention",
		nodes: [{ taskId: "done", agent: "scout", task: "done", outputArtifact: "done.md", sideEffect: "local_read" }],
	}, root);
	const runs = join(root, "runs");
	const store = new GraphStore(runs, graphId);
	const snapshot = initialSnapshot(graph, root);
	const attemptRoot = store.path("nodes", "done", "attempt-1");
	snapshot.status = "complete";
	snapshot.updatedAt = new Date(Date.now() - 200 * 86_400_000).toISOString();
	snapshot.nodes.done = {
		taskId: "done",
		status: "accepted",
		attempt: 1,
		attempts: [{
			attempt: 1,
			status: "accepted",
			sessionDir: join(attemptRoot, "session"),
			workspaceDir: join(attemptRoot, "workspace"),
			workspaceKind: "shadow",
			outputPath: store.path("artifacts", "done.md"),
			manifestPath: join(attemptRoot, "result-manifest.json"),
		}],
	};
	await store.initialize(graph, snapshot);
	await mkdir(join(attemptRoot, "session"), { recursive: true });
	await mkdir(join(attemptRoot, "workspace"), { recursive: true });
	await writeFile(join(attemptRoot, "session", "session.jsonl"), "temporary");
	await writeFile(join(attemptRoot, "workspace", "large.tmp"), "x".repeat(4096));
	await mkdir(store.path("artifacts"), { recursive: true });
	await writeFile(store.path("artifacts", "done.md"), "result");
	await writeFile(join(attemptRoot, "result-manifest.json"), "{}");
	await writeFile(store.path("history.json"), JSON.stringify({
		schemaVersion: 1,
		runInstanceId: `legacy-${(await import("node:crypto")).createHash("sha256").update(`${graphId}\0${snapshot.createdAt}`).digest("hex").slice(0, 32)}`,
		graphId,
		revision: 0,
		terminalAt: snapshot.updatedAt,
		updatedAt: snapshot.updatedAt,
	}));
	return { graph, runs, store, snapshot };
}

function maintenanceConfig(runsDir: string): GraphConfig {
	return {
		enabled: true,
		runsDir,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		history: {
			autoCompact: false,
			compactAfterDays: 7,
			autoPrune: false,
			emergencyPurge: false,
			pruneAfterDays: 180,
			trashGraceDays: 7,
			maxStorageBytes: 1024 ** 3,
			targetStorageBytes: 512 * 1024 ** 2,
			keepRecentTerminal: 0,
		},
	};
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

test("transactional compact removes only regenerable terminal directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-compact-"));
	const { runs, store } = await terminalFixture(root, "compact");
	const result = await compactRun(runs, "compact", { force: true });
	assert.equal(result.compacted, true);
	assert.ok(result.bytesReclaimed > 4096);
	await assert.rejects(readFile(store.path("nodes", "done", "attempt-1", "workspace", "large.tmp"), "utf8"), /ENOENT/);
	assert.equal(await readFile(store.path("artifacts", "done.md"), "utf8"), "result");
	assert.ok(JSON.parse(await readFile(store.path("history.json"), "utf8")).compactedAt);
	assert.equal(JSON.parse(await readFile(store.path("compaction.json"), "utf8")).status, "committed");
});

test("pinned runs and attention runs remain protected from compact and prune", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-protected-"));
	const { runs } = await terminalFixture(root, "pinned");
	await updateHistoryFlag(runs, "pinned", "pin");
	assert.match((await compactRun(runs, "pinned", { force: true })).reason ?? "", /pinned/);
	await assert.rejects(createPrunePlan(runs, ["pinned"]), /protected/);
});

test("v2 Trash authorization requires the complete authority evidence chain", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v2-trash-evidence-"));
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-evidence",
		goal: "retention evidence",
		nodes: [{ taskId: "done", agent: "scout", task: "done", outputArtifact: "done.md", sideEffect: "local_read" }],
	}, root, 20, 2);
	const runs = join(root, "runs");
	const store = new GraphStore(runs, graph.graphId);
	const snapshot = initialSnapshot(graph, root, undefined, 2);
	const attemptRoot = store.path("nodes", "done", "attempt-1");
	snapshot.status = "complete";
	snapshot.nodes.done = {
		taskId: "done",
		status: "accepted",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce: randomUUID(),
			status: "accepted",
			sessionDir: join(attemptRoot, "session"),
			workspaceDir: join(attemptRoot, "workspace"),
			workspaceKind: "shadow",
			outputPath: join(attemptRoot, "output", "done.md"),
			manifestPath: join(attemptRoot, "result-manifest.json"),
		}],
	};
	await store.initialize(graph, snapshot);
	await assert.rejects(createPrunePlan(runs, [graph.graphId]), /Invalid attempt authority/);
	assert.equal((await GraphStore.list(runs)).includes(graph.graphId), true);
});

test("prune plan is identity-bound, moves to same-disk Trash, restores, and purges", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-trash-"));
	const { runs } = await terminalFixture(root, "trashable");
	await compactRun(runs, "trashable", { force: true });
	const stale = await createPrunePlan(runs, ["trashable"]);
	await updateHistoryFlag(runs, "trashable", "archive");
	await assert.rejects(executePrunePlan(runs, stale.planId, 7, stale.planDigest), /stale/);
	await assert.rejects(createPrunePlan(runs, ["trashable"]), /archived/);
	await updateHistoryFlag(runs, "trashable", "unarchive");
	const plan = await createPrunePlan(runs, ["trashable"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 7, plan.planDigest);
	assert.ok(trashId);
	assert.equal((await GraphStore.list(runs)).includes("trashable"), false);
	assert.equal((await listTrash(runs))[0]?.trashId, trashId);
	assert.equal(await restoreTrash(runs, trashId!), "trashable");
	assert.equal((await GraphStore.list(runs)).includes("trashable"), true);
	await updateHistoryFlag(runs, "trashable", "unpin");
	const finalPlan = await createPrunePlan(runs, ["trashable"]);
	const [finalTrash] = await executePrunePlan(runs, finalPlan.planId, 7, finalPlan.planDigest);
	assert.deepEqual(await purgeTrash(runs), []);
	assert.deepEqual(await purgeTrash(runs, { force: true }), [finalTrash]);
});

test("automatic maintenance compacts and prunes only when explicitly enabled", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-auto-retention-"));
	const { runs } = await terminalFixture(root, "automatic");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		history: {
			autoCompact: true,
			compactAfterDays: 7,
			autoPrune: false,
			emergencyPurge: false,
			pruneAfterDays: 180,
			trashGraceDays: 7,
			maxStorageBytes: 1024 ** 3,
			targetStorageBytes: 512 * 1024 ** 2,
			keepRecentTerminal: 0,
		},
	};
	const first = await runRetentionMaintenance(config);
	assert.deepEqual(first.compacted, ["automatic"]);
	assert.deepEqual(first.trashed, []);
	config.history!.autoPrune = true;
	const second = await runRetentionMaintenance(config);
	assert.equal(second.trashed.length, 1);
	assert.equal((await listTrash(runs)).length, 1);
});

test("maintenance does not acquire per-run Supervisors for clean non-candidates", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-retention-preflight-"));
	const { runs, store, snapshot } = await terminalFixture(root, "recent-terminal");
	const recent = new Date().toISOString();
	snapshot.updatedAt = recent;
	await store.saveSnapshot(snapshot);
	const historyPath = store.path("history.json");
	const history = JSON.parse(await readFile(historyPath, "utf8"));
	history.terminalAt = recent;
	history.updatedAt = recent;
	await writeFile(historyPath, JSON.stringify(history));
	const config = maintenanceConfig(runs);
	config.history!.autoCompact = true;
	let graphSupervisorAcquisitions = 0;
	const original = GraphStore.prototype.acquireSupervisor;
	GraphStore.prototype.acquireSupervisor = async function (...args: Parameters<GraphStore["acquireSupervisor"]>) {
		graphSupervisorAcquisitions += 1;
		return original.apply(this, args);
	};
	try {
		await runRetentionMaintenance(config);
		assert.equal(graphSupervisorAcquisitions, 0);
	} finally {
		GraphStore.prototype.acquireSupervisor = original;
	}
});

test("quota pressure purges only Trash that autoPrune already authorized", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-quota-retention-"));
	const { runs } = await terminalFixture(root, "quota");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		history: {
			autoCompact: true,
			compactAfterDays: 0,
			autoPrune: true,
			emergencyPurge: true,
			pruneAfterDays: 1,
			trashGraceDays: 7,
			maxStorageBytes: 1,
			targetStorageBytes: 0,
			keepRecentTerminal: 0,
		},
	};
	await runRetentionMaintenance(config);
	const report = await runRetentionMaintenance(config);
	assert.equal(report.trashed.length, 1);
	assert.equal(report.purged.length, 1);
	assert.equal((await listTrash(runs)).length, 0);
});

test("quota pressure never bypasses Trash grace unless emergencyPurge is explicit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-quota-grace-"));
	const { runs } = await terminalFixture(root, "quota-grace");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		history: {
			autoCompact: true,
			compactAfterDays: 0,
			autoPrune: true,
			emergencyPurge: false,
			pruneAfterDays: 1,
			trashGraceDays: 7,
			maxStorageBytes: 1,
			targetStorageBytes: 0,
			keepRecentTerminal: 0,
		},
	};
	await runRetentionMaintenance(config);
	const report = await runRetentionMaintenance(config);
	assert.equal(report.trashed.length, 1);
	assert.deepEqual(report.purged, []);
	assert.equal((await listTrash(runs)).length, 1);
});

test("emergency quota decisions include control and recovery storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-quota-control-bytes-"));
	const { runs } = await terminalFixture(root, "quota-control");
	const config = maintenanceConfig(runs);
	config.history!.autoCompact = true;
	config.history!.compactAfterDays = 0;
	config.history!.autoPrune = true;
	config.history!.pruneAfterDays = 1;
	config.history!.trashGraceDays = 7;
	config.history!.keepRecentTerminal = 0;
	await runRetentionMaintenance(config);
	await runRetentionMaintenance(config);
	assert.equal((await listTrash(runs)).length, 1);
	const baseline = await storageReport(config);
	config.history!.maxStorageBytes = baseline.graphBytes + baseline.trashBytes + 1_024;
	config.history!.targetStorageBytes = 0;
	config.history!.emergencyPurge = true;
	await writeFile(join(runs, ".control", "quota-pressure.bin"), "x".repeat(64 * 1024));
	const report = await runRetentionMaintenance(config);
	assert.equal(report.purged.length, 1);
	assert.equal((await listTrash(runs)).length, 0);
});

test("compaction refuses a symlink candidate and never touches its external target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-compact-symlink-"));
	const { runs, store } = await terminalFixture(root, "symlinked");
	const session = store.path("nodes", "done", "attempt-1", "session");
	const external = join(root, "external");
	await mkdir(external);
	await writeFile(join(external, "keep.txt"), "keep");
	await rm(session, { recursive: true });
	await symlink(external, session);
	await assert.rejects(compactRun(runs, "symlinked", { force: true }), /symbolic link|real directory/);
	assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
});

test("compaction refuses a graph root symlink and never touches the external run", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-root-symlink-"));
	const externalRoot = join(root, "external");
	const { store } = await terminalFixture(externalRoot, "linked");
	const runs = join(root, "runs");
	await mkdir(runs);
	await symlink(store.root, join(runs, "linked"));
	await assert.rejects(compactRun(runs, "linked", { force: true }), /Graph root must be a real directory/);
	assert.equal(await readFile(store.path("nodes", "done", "attempt-1", "session", "session.jsonl"), "utf8"), "temporary");
});

test("maintenance rejects a prune plan root symlink without deleting external files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-prune-root-symlink-"));
	const runs = join(root, "runs");
	const external = join(root, "external");
	await mkdir(join(runs, ".control"), { recursive: true });
	await mkdir(external);
	await writeFile(join(external, "important.json"), "{}");
	await symlink(external, join(runs, ".control", "prune-plans"));
	await assert.rejects(runRetentionMaintenance(maintenanceConfig(runs)), /Prune plan directory.*symbolic link|symbolic link.*Prune plan directory/i);
	assert.equal(await readFile(join(external, "important.json"), "utf8"), "{}");
});

test("maintenance rejects a purge staging symlink without deleting external files", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-purge-root-symlink-"));
	const runs = join(root, "runs");
	const external = join(root, "external");
	await mkdir(join(runs, ".control"), { recursive: true });
	await mkdir(external);
	await writeFile(join(external, "important.json"), "{}");
	await symlink(external, join(runs, ".control", "purge-staging"));
	await assert.rejects(runRetentionMaintenance(maintenanceConfig(runs)), /Purge staging directory.*symbolic link|symbolic link.*Purge staging directory/i);
	assert.equal(await readFile(join(external, "important.json"), "utf8"), "{}");
});

test("maintenance rejects every managed control root symlink without touching its target", async (t) => {
	for (const name of ["retention-lock", "graph-locks", "graph-lock-gate", "graph-lock-quarantine", "restore-transactions", "restore-quarantine", "purge-authorizations", "purge-staging", "purge-quarantine", "prune-plans", "source-reservations", "source-reservation-gate"]) {
		await t.test(name, async () => {
			const root = await mkdtemp(join(tmpdir(), `pi-graph-control-${name}-`));
			const runs = join(root, "runs");
			const external = join(root, "external");
			await mkdir(join(runs, ".control"), { recursive: true });
			await mkdir(external);
			await writeFile(join(external, "important.json"), "{}");
			await symlink(external, join(runs, ".control", name));
			await assert.rejects(runRetentionMaintenance(maintenanceConfig(runs)), /symbolic link|non-directory/i);
			assert.equal(await readFile(join(external, "important.json"), "utf8"), "{}");
		});
	}
});

test("maintenance rejects source reservation history symlinks without traversing their targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-reservation-history-symlink-"));
	const runs = join(root, "runs");
	const reservations = join(runs, ".control", "source-reservations");
	const external = join(root, "external");
	await mkdir(reservations, { recursive: true });
	await mkdir(external);
	await writeFile(join(external, "important.json"), JSON.stringify({
		version: 1,
		state: "released",
		updatedAt: new Date(0).toISOString(),
	}));
	await symlink(external, join(reservations, ".history"));
	await assert.rejects(runRetentionMaintenance(maintenanceConfig(runs)), /Source reservation tree.*real directory|symbolic link/i);
	assert.match(await readFile(join(external, "important.json"), "utf8"), /released/);
});

test("maintenance unlinks invalid Graph lock entries without following external targets", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lock-entry-cleanup-"));
	const runs = join(root, "runs");
	const lockRoot = join(runs, ".control", "graph-locks");
	const quarantineRoot = join(runs, ".control", "graph-lock-quarantine");
	const external = join(root, "external");
	await Promise.all([
		mkdir(lockRoot, { recursive: true }),
		mkdir(quarantineRoot, { recursive: true }),
		mkdir(external),
	]);
	await writeFile(join(external, "keep.txt"), "keep");
	await symlink(external, join(lockRoot, "linked-lock"));
	await writeFile(join(lockRoot, "file-lock"), "invalid");
	await symlink(external, join(quarantineRoot, "linked-quarantine"));

	const before = await doctorGraphRuns(runs);
	assert.ok(before.controlProtected.some((entry) => entry.path === ".control/graph-locks/linked-lock"));
	assert.ok(before.controlProtected.some((entry) => entry.path === ".control/graph-locks/file-lock"));
	assert.ok(before.controlProtected.some((entry) => entry.path === ".control/graph-lock-quarantine/linked-quarantine"));

	await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(join(lockRoot, "linked-lock")), /ENOENT/);
	await assert.rejects(lstat(join(lockRoot, "file-lock")), /ENOENT/);
	await assert.rejects(lstat(join(quarantineRoot, "linked-quarantine")), /ENOENT/);
	assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
	const after = await doctorGraphRuns(runs);
	assert.equal(after.controlProtected.some((entry) => entry.path.includes("linked-lock") || entry.path.includes("file-lock") || entry.path.includes("linked-quarantine")), false);
});

test("maintenance reports structurally damaged graph directories instead of hiding them", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-damaged-visible-"));
	const runs = join(root, "runs");
	await mkdir(join(runs, "damaged-run"), { recursive: true });
	await writeFile(join(runs, "damaged-run", "snapshot.json"), "{not-json");
	const report = await runRetentionMaintenance(maintenanceConfig(runs));
	assert.equal(report.runs, 1);
	assert.equal(report.protected.some((entry) => entry.graphId === "damaged-run"), true);
});

test("interrupted prepared compaction is rolled back before retention eligibility is evaluated", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-compact-recover-"));
	const { runs, store } = await terminalFixture(root, "recover-compact");
	const planId = randomUUID();
	const token = "nodes/done/attempt-1/session";
	const source = store.path(token);
	const target = store.path(".compact-staging", planId, token);
	await mkdir(join(target, ".."), { recursive: true });
	await rename(source, target);
	await writeFile(store.path("compaction.json"), JSON.stringify({
		schemaVersion: 1,
		planId,
		status: "prepared",
		candidates: [token],
		preparedAt: new Date().toISOString(),
	}));
	const result = await compactRun(runs, "recover-compact", { compactAfterDays: 1000 });
	assert.equal(result.compacted, false);
	assert.match(result.reason ?? "", /age/);
	assert.equal(await readFile(join(source, "session.jsonl"), "utf8"), "temporary");
	assert.equal(JSON.parse(await readFile(store.path("compaction.json"), "utf8")).status, "rolled_back");
});

test("prune confirmation is digest-bound and plans cannot span multiple graph runs", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-prune-digest-"));
	const { runs } = await terminalFixture(root, "digest-bound");
	const plan = await createPrunePlan(runs, ["digest-bound"]);
	await assert.rejects(executePrunePlan(runs, plan.planId, 7, "0".repeat(64)), /confirmation digest/);
	const path = join(runs, ".control", "prune-plans", `${plan.planId}.json`);
	const replaced = JSON.parse(await readFile(path, "utf8"));
	replaced.expiresAt = new Date(Date.now() + 60_000).toISOString();
	await writeFile(path, JSON.stringify(replaced));
	await assert.rejects(executePrunePlan(runs, plan.planId, 7, plan.planDigest), /digest mismatch/);
	await assert.rejects(createPrunePlan(runs, ["digest-bound", "other"]), /exactly one/);
});

test("invalid Trash timestamps are visible and protected from purge", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-trash-invalid-time-"));
	const { runs } = await terminalFixture(root, "invalid-time");
	const plan = await createPrunePlan(runs, ["invalid-time"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 0, plan.planDigest);
	const path = join(runs, ".trash", trashId!, "trash.json");
	const record = JSON.parse(await readFile(path, "utf8"));
	record.purgeAfter = "not-a-time";
	await writeFile(path, JSON.stringify(record));
	const inventory = await listTrashInventory(runs);
	assert.equal(inventory.valid.length, 0);
	assert.equal(inventory.protected[0]?.trashId, trashId);
	assert.deepEqual(await purgeTrash(runs, { force: true }), []);
	assert.equal(await readFile(path, "utf8").then(() => true), true);
	await discardProtectedTrash(runs, trashId!);
	assert.deepEqual(await listTrashInventory(runs), { valid: [], protected: [] });
});

test("discarding a protected Trash symlink unlinks only the symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-trash-symlink-"));
	const runs = join(root, "runs");
	const trash = join(runs, ".trash");
	const external = join(root, "external");
	await mkdir(trash, { recursive: true });
	await mkdir(external);
	await writeFile(join(external, "keep.txt"), "keep");
	await symlink(external, join(trash, "bad-link"));
	const inventory = await listTrashInventory(runs);
	assert.match(inventory.protected[0]?.reason ?? "", /symbolic link/);
	await discardProtectedTrash(runs, "bad-link");
	assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
	assert.deepEqual(await listTrashInventory(runs), { valid: [], protected: [] });
});

test("restored runs are pinned and storage inspection is read-only", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-restore-pin-"));
	const { runs, store } = await terminalFixture(root, "restore-pin");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		history: {
			autoCompact: true,
			compactAfterDays: 0,
			autoPrune: true,
			emergencyPurge: false,
			pruneAfterDays: 1,
			trashGraceDays: 7,
			maxStorageBytes: 1024 ** 3,
			targetStorageBytes: 512 * 1024 ** 2,
			keepRecentTerminal: 0,
		},
	};
	await storageReport(config);
	assert.equal(await readFile(store.path("nodes", "done", "attempt-1", "session", "session.jsonl"), "utf8"), "temporary");
	const plan = await createPrunePlan(runs, ["restore-pin"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 7, plan.planDigest);
	await restoreTrash(runs, trashId!);
	const history = JSON.parse(await readFile(store.path("history.json"), "utf8"));
	assert.equal(typeof history.restoredAt, "string");
	assert.equal(history.pinnedAt, history.restoredAt);
	await assert.rejects(createPrunePlan(runs, ["restore-pin"]), /pinned/);
});

test("maintenance commits a restore transaction that crashed after the rename", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-restore-recover-"));
	const { runs } = await terminalFixture(root, "restore-recover");
	const plan = await createPrunePlan(runs, ["restore-recover"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 7, plan.planDigest);
	const source = join(runs, ".trash", trashId!);
	const target = join(runs, "restore-recover");
	const record = JSON.parse(await readFile(join(source, "trash.json"), "utf8"));
	const transaction = {
		schemaVersion: 1,
		transactionId: randomUUID(),
		trashId,
		graphId: record.graphId,
		runInstanceId: record.runInstanceId,
		record,
		recordDigest: digest(record),
		source,
		target,
		preparedAt: new Date().toISOString(),
	};
	const transactions = join(runs, ".control", "restore-transactions");
	await mkdir(transactions, { recursive: true });
	await writeFile(join(transactions, `${trashId}.json`), JSON.stringify(transaction));
	await rename(source, target);
	const config = maintenanceConfig(runs);
	config.history!.autoPrune = true;
	const report = await runRetentionMaintenance(config);
	assert.deepEqual(report.trashed, []);
	const history = JSON.parse(await readFile(join(target, "history.json"), "utf8"));
	assert.equal(typeof history.restoredAt, "string");
	assert.equal(history.pinnedAt, history.restoredAt);
	await assert.rejects(readFile(join(transactions, `${trashId}.json`), "utf8"), /ENOENT/);
});

test("restore rollback never follows a substituted graph-root symlink", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-restore-rollback-link-"));
	const { runs } = await terminalFixture(root, "restore-rollback-link");
	const plan = await createPrunePlan(runs, ["restore-rollback-link"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 7, plan.planDigest);
	const source = join(runs, ".trash", trashId!);
	const target = join(runs, "restore-rollback-link");
	const record = JSON.parse(await readFile(join(source, "trash.json"), "utf8"));
	const transactions = join(runs, ".control", "restore-transactions");
	const transactionPath = join(transactions, `${trashId}.json`);
	await mkdir(transactions, { recursive: true });
	await writeFile(transactionPath, JSON.stringify({
		schemaVersion: 1,
		transactionId: randomUUID(),
		trashId,
		graphId: record.graphId,
		runInstanceId: record.runInstanceId,
		record,
		recordDigest: digest(record),
		source,
		target,
		preparedAt: new Date().toISOString(),
	}));
	await rename(source, target);
	await rm(target, { recursive: true });
	const external = join(root, "external");
	await mkdir(external);
	await writeFile(join(external, "keep.txt"), "keep");
	await symlink(external, target);

	const report = await runRetentionMaintenance(maintenanceConfig(runs));
	assert.ok(report.protected.some((entry) => entry.graphId.includes("restore-transactions") && entry.reason.includes("rollback")));
	assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
	await assert.rejects(readFile(join(external, "restore-protection.json"), "utf8"), /ENOENT/);
	assert.equal((await lstat(target)).isSymbolicLink(), true);
	assert.equal(typeof JSON.parse(await readFile(transactionPath, "utf8")).transactionId, "string");
});

test("maintenance finishes a staged purge after trash metadata was partially deleted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-purge-recover-"));
	const { runs } = await terminalFixture(root, "purge-recover");
	const plan = await createPrunePlan(runs, ["purge-recover"]);
	const [trashId] = await executePrunePlan(runs, plan.planId, 0, plan.planDigest);
	const source = join(runs, ".trash", trashId!);
	const record = JSON.parse(await readFile(join(source, "trash.json"), "utf8"));
	const authorizations = join(runs, ".control", "purge-authorizations");
	const stagingRoot = join(runs, ".control", "purge-staging");
	const staging = join(stagingRoot, trashId!);
	await mkdir(authorizations, { recursive: true });
	await mkdir(stagingRoot, { recursive: true });
	const authorization = {
		schemaVersion: 2,
		kind: "valid-trash",
		trashId,
		record,
		recordDigest: digest(record),
		source,
		staging,
		authorizedAt: new Date().toISOString(),
	};
	const authorizationPath = join(authorizations, `${trashId}.json`);
	await writeFile(authorizationPath, JSON.stringify(authorization));
	await rename(source, staging);
	await rm(join(staging, "trash.json"));
	await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(readFile(authorizationPath, "utf8"), /ENOENT/);
	await assert.rejects(readFile(staging, "utf8"), /ENOENT|EISDIR/);
	assert.deepEqual(await listTrashInventory(runs), { valid: [], protected: [] });
});

test("orphan purge staging counts toward storage and requires explicit discard", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-orphan-purge-staging-"));
	const runs = join(root, "runs");
	const staging = join(runs, ".control", "purge-staging", "orphan-stage");
	await mkdir(staging, { recursive: true });
	await writeFile(join(staging, "payload.bin"), "x".repeat(8192));
	const config = maintenanceConfig(runs);
	config.history!.maxStorageBytes = 1;
	config.history!.targetStorageBytes = 0;

	const inspected = await storageReport(config);
	assert.ok(inspected.controlBytes >= 8192);
	assert.equal(inspected.overSoftLimit, true);
	assert.ok(inspected.protected.some((entry) => entry.graphId === ".control/purge-staging/orphan-stage" && entry.reason.includes("explicit discard")));

	const maintained = await runRetentionMaintenance(config);
	assert.ok(maintained.protected.some((entry) => entry.graphId === ".control/purge-staging/orphan-stage"));
	assert.equal(await readFile(join(staging, "payload.bin"), "utf8"), "x".repeat(8192));

	await discardOrphanPurgeStaging(runs, "orphan-stage");
	await assert.rejects(readFile(join(staging, "payload.bin"), "utf8"), /ENOENT/);
	const cleared = await storageReport(config);
	assert.equal(cleared.protected.some((entry) => entry.graphId === ".control/purge-staging/orphan-stage"), false);
});

test("discarding orphan purge staging symlink never touches its external target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-orphan-purge-staging-link-"));
	const runs = join(root, "runs");
	const stagingRoot = join(runs, ".control", "purge-staging");
	const external = join(root, "external");
	await mkdir(stagingRoot, { recursive: true });
	await mkdir(external, { recursive: true });
	await writeFile(join(external, "keep.txt"), "keep");
	await symlink(external, join(stagingRoot, "orphan-link"));
	await discardOrphanPurgeStaging(runs, "orphan-link");
	assert.equal(await readFile(join(external, "keep.txt"), "utf8"), "keep");
	await assert.rejects(lstat(join(stagingRoot, "orphan-link")), /ENOENT/);
});

test("explicit staging discard replaces only its matching corrupt purge authorization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-corrupt-purge-authorization-"));
	const runs = join(root, "runs");
	const staging = join(runs, ".control", "purge-staging", "corrupt-stage");
	const authorizations = join(runs, ".control", "purge-authorizations");
	const authorizationPath = join(authorizations, "corrupt-stage.json");
	await mkdir(staging, { recursive: true });
	await mkdir(authorizations, { recursive: true });
	await writeFile(join(staging, "payload.bin"), "x".repeat(8192));
	await writeFile(authorizationPath, "{corrupt");
	const inspected = await storageReport(maintenanceConfig(runs));
	assert.ok(inspected.protected.some((entry) => entry.graphId === ".control/purge-staging/corrupt-stage" && entry.reason.includes("invalid")));
	const maintained = await runRetentionMaintenance(maintenanceConfig(runs));
	assert.ok(maintained.protected.some((entry) => entry.graphId === ".control/purge-staging/corrupt-stage"));

	await discardOrphanPurgeStaging(runs, "corrupt-stage");
	await assert.rejects(lstat(staging), /ENOENT/);
	await assert.rejects(lstat(authorizationPath), /ENOENT/);
	assert.equal((await runRetentionMaintenance(maintenanceConfig(runs))).protected.length, 0);
});

test("explicit staging discard quarantines a directory-shaped authorization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-directory-purge-authorization-"));
	const runs = join(root, "runs");
	const staging = join(runs, ".control", "purge-staging", "directory-stage");
	const authorizationPath = join(runs, ".control", "purge-authorizations", "directory-stage.json");
	await mkdir(staging, { recursive: true });
	await mkdir(authorizationPath, { recursive: true });
	await writeFile(join(staging, "payload.bin"), "payload");
	await writeFile(join(authorizationPath, "invalid.txt"), "invalid");

	await discardOrphanPurgeStaging(runs, "directory-stage");
	await assert.rejects(lstat(staging), /ENOENT/);
	await assert.rejects(lstat(authorizationPath), /ENOENT/);
	await assert.rejects(lstat(join(runs, ".control", "purge-quarantine", "directory-stage.invalid")), /ENOENT/);
});

test("invalid purge staging names are removable through their opaque storage handle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-invalid-purge-staging-name-"));
	const runs = join(root, "runs");
	const staging = join(runs, ".control", "purge-staging", "invalid stage name");
	await mkdir(staging, { recursive: true });
	await writeFile(join(staging, "payload.bin"), "payload");
	const inspected = await storageReport(maintenanceConfig(runs));
	const entry = inspected.protected.find((item) => item.graphId.startsWith(".control/purge-staging/orphan-"));
	assert.ok(entry);
	const handle = entry.graphId.slice(".control/purge-staging/".length);
	assert.match(handle, /^orphan-[a-f0-9]{16}$/);

	await discardOrphanPurgeStaging(runs, handle);
	await assert.rejects(lstat(staging), /ENOENT/);
	assert.equal((await storageReport(maintenanceConfig(runs))).protected.some((item) => item.graphId.includes(handle)), false);
});

test("maintenance removes purge quarantine left after staging was already deleted", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-purge-quarantine-crash-"));
	const runs = join(root, "runs");
	const quarantine = join(runs, ".control", "purge-quarantine", "finished-stage.invalid");
	await mkdir(dirname(quarantine), { recursive: true });
	await writeFile(quarantine, "{invalid");
	const report = await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(quarantine), /ENOENT/);
	assert.equal(report.protected.some((entry) => entry.graphId.includes("finished-stage.invalid")), false);
});

test("invalid restore metadata is isolated without blocking maintenance and has a Pi-safe discard handle", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-restore-quarantine-"));
	const { runs } = await terminalFixture(root, "restore-quarantine-run");
	const transactions = join(runs, ".control", "restore-transactions");
	await mkdir(transactions, { recursive: true });
	await writeFile(join(transactions, "broken transaction.json"), "{broken");
	const report = await runRetentionMaintenance(maintenanceConfig(runs));
	const isolated = report.protected.find((entry) => entry.graphId.startsWith(".control/restore-quarantine/restore-"));
	assert.ok(isolated);
	assert.equal(report.protected.filter((entry) => entry.graphId === isolated.graphId).length, 1);
	const handle = isolated.graphId.slice(".control/restore-quarantine/".length);
	assert.match(handle, /^restore-[a-f0-9]{16}\.invalid$/);
	await discardControlQuarantine(runs, handle);
	assert.equal((await storageReport(maintenanceConfig(runs))).protected.some((entry) => entry.graphId.includes(handle)), false);
});

test("abandoned initialization staging is visible and maintenance reclaims it automatically", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-initialize-staging-gc-"));
	const runs = join(root, "runs");
	const stagingName = `.initialize-crashed-${randomUUID()}`;
	const staging = join(runs, stagingName);
	await mkdir(staging, { recursive: true });
	await writeFile(join(staging, "partial.bin"), "x".repeat(4096));
	const lockRoot = join(runs, ".control", "graph-locks", "crashed");
	await mkdir(join(lockRoot, "claims"), { recursive: true });
	await writeFile(join(lockRoot, "generation.json"), JSON.stringify({ version: 1, graphId: "crashed", generation: 1 }));
	assert.ok((await storageReport(maintenanceConfig(runs))).protected.some((entry) => entry.graphId === stagingName));
	assert.ok((await doctorGraphRuns(runs)).controlProtected.some((entry) => entry.path === stagingName));
	const maintained = await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(staging), /ENOENT/);
	await assert.rejects(lstat(join(runs, ".control", "graph-locks", "crashed")), /ENOENT/);
	assert.equal(maintained.protected.some((entry) => entry.graphId === stagingName), false);
});

test("orphan Graph lock cleanup cannot interrupt a concurrent initialization", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-lock-gate-race-"));
	const runs = join(root, "runs");
	const graphId = "concurrent-initialization";
	const lockRoot = join(runs, ".control", "graph-locks", graphId);
	await mkdir(join(lockRoot, "claims"), { recursive: true });
	await writeFile(join(lockRoot, "generation.json"), JSON.stringify({ version: 1, graphId, generation: 1 }));
	let enterGate!: () => void;
	let releaseGate!: () => void;
	const gateEntered = new Promise<void>((resolve) => { enterGate = resolve; });
	const gateRelease = new Promise<void>((resolve) => { releaseGate = resolve; });
	const gateHolder = GraphStore.withGraphLockMutationGate(runs, graphId, "test-holder", async () => {
		enterGate();
		await gateRelease;
	});
	await gateEntered;
	const maintenance = runRetentionMaintenance(maintenanceConfig(runs));
	await new Promise((resolve) => setTimeout(resolve, 75));
	const graph = compileGraph({
		schemaVersion: 1,
		graphId,
		goal: "concurrent initialization",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, root, 2, 2);
	const store = new GraphStore(runs, graphId);
	const initialization = store.initialize(graph, initialSnapshot(graph, root, "session", 2));
	await new Promise((resolve) => setTimeout(resolve, 25));
	releaseGate();
	await Promise.all([gateHolder, maintenance, initialization]);
	assert.equal((await store.loadSnapshot()).graphId, graphId);
	assert.doesNotReject(lstat(join(runs, ".control", "graph-locks", graphId, "generation.json")));
	const quarantine = join(runs, ".control", "graph-lock-quarantine");
	const quarantineEntries = await readdir(quarantine).catch((error) => {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	});
	assert.deepEqual(quarantineEntries, []);
});

test("maintenance preserves initialization staging owned by a live Supervisor", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-initialize-staging-live-"));
	const runs = join(root, "runs");
	const graphId = "live-initialization";
	const owner = new GraphStore(runs, graphId);
	const release = await owner.acquireSupervisor("live-initialization");
	const stagingName = `.initialize-${graphId}-${randomUUID()}`;
	const staging = join(runs, stagingName);
	await mkdir(staging);
	await writeFile(join(staging, "partial.json"), "{}");
	const protectedReport = await runRetentionMaintenance(maintenanceConfig(runs));
	assert.ok(protectedReport.protected.some((entry) => entry.graphId === stagingName && entry.reason.includes("live Graph Supervisor")));
	assert.doesNotReject(lstat(staging));
	await release();
	await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(staging), /ENOENT/);
});

test("corrupt fencing generation is diagnosed, recovered under an exclusive claim, and cleaned", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-generation-recovery-"));
	const { runs, store } = await terminalFixture(root, "generation-recovery");
	const lockRoot = join(runs, ".control", "graph-locks", "generation-recovery");
	const generation = join(lockRoot, "generation.json");
	await writeFile(generation, "{broken");
	assert.ok((await doctorGraphRuns(runs)).controlProtected.some((entry) => entry.path.endsWith("/generation.json")));
	const recoveryStore = new GraphStore(runs, "generation-recovery");
	const release = await recoveryStore.acquireSupervisor("recover-generation");
	const snapshot = await recoveryStore.loadSnapshot();
	await recoveryStore.saveSnapshot(snapshot);
	await release();
	assert.equal(JSON.parse(await readFile(generation, "utf8")).graphId, "generation-recovery");
	assert.ok((await readdir(lockRoot)).some((name) => name.startsWith("generation.invalid-")));
	await runRetentionMaintenance(maintenanceConfig(runs));
	assert.equal((await readdir(lockRoot)).some((name) => name.startsWith("generation.invalid-")), false);
	assert.equal((await doctorGraphRuns(runs)).controlProtected.some((entry) => entry.path.includes("generation")), false);
	assert.equal((await store.loadSnapshot()).graphId, "generation-recovery");
});

test("dead corrupt retention claims are recovered and remain visible to doctor before maintenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-retention-claim-recovery-"));
	const runs = join(root, "runs");
	const claims = join(runs, ".control", "retention-lock", "claims");
	const claim = join(claims, `999999999-${randomUUID()}.json`);
	await mkdir(claims, { recursive: true });
	await writeFile(claim, "{broken");
	assert.ok((await doctorGraphRuns(runs)).controlProtected.some((entry) => entry.path.includes("retention-lock/claims")));
	await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(claim), /ENOENT/);
});

test("directory-shaped prune plans are removable by cancellation and maintenance", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-prune-plan-directory-"));
	const runs = join(root, "runs");
	const plans = join(runs, ".control", "prune-plans");
	const cancelledId = randomUUID();
	const collectedId = randomUUID();
	await mkdir(join(plans, `${cancelledId}.json`), { recursive: true });
	await cancelPrunePlan(runs, cancelledId);
	await assert.rejects(lstat(join(plans, `${cancelledId}.json`)), /ENOENT/);
	await mkdir(join(plans, `${collectedId}.json`), { recursive: true });
	await runRetentionMaintenance(maintenanceConfig(runs));
	await assert.rejects(lstat(join(plans, `${collectedId}.json`)), /ENOENT/);
});

test("invalid protected Trash names are exposed and discarded through opaque handles", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-invalid-trash-name-"));
	const runs = join(root, "runs");
	const target = join(runs, ".trash", "invalid trash name");
	await mkdir(target, { recursive: true });
	await writeFile(join(target, "payload.bin"), "payload");
	const inventory = await listTrashInventory(runs);
	const handle = inventory.protected[0]?.trashId;
	assert.match(handle ?? "", /^invalid-trash-[a-f0-9]{16}$/);
	await discardProtectedTrash(runs, handle!);
	await assert.rejects(lstat(target), /ENOENT/);
});

test("storage inspection rejects a symbolic-link control ancestor without enumerating its target", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-storage-control-link-"));
	const runs = join(root, "runs");
	const external = join(root, "external-control");
	await mkdir(join(external, "purge-staging", "private-entry"), { recursive: true });
	await mkdir(runs);
	await symlink(external, join(runs, ".control"));
	await assert.rejects(storageReport(maintenanceConfig(runs)), /symbolic link/);
	assert.equal((await readdir(join(external, "purge-staging"))).includes("private-entry"), true);
});

test("needs_attention requires explicit acknowledgement before manual disposal", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-attention-ack-"));
	const { runs, store } = await terminalFixture(root, "attention");
	const snapshot = await store.loadSnapshot();
	snapshot.status = "needs_attention";
	snapshot.nodes.done!.status = "failed";
	snapshot.nodes.done!.attempts[0]!.status = "failed";
	await store.saveSnapshot(snapshot);
	await mkdir(store.path("incidents"));
	await writeFile(store.path("incidents", "incident.json"), "{}");
	await assert.rejects(createPrunePlan(runs, ["attention"]), /acknowledged/);
	await updateHistoryFlag(runs, "attention", "acknowledge");
	const plan = await createPrunePlan(runs, ["attention"]);
	assert.equal(plan.entries[0]?.graphId, "attention");
});

test("a new needs_attention incident cannot reuse an earlier acknowledgement", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-attention-generation-"));
	const { runs, store } = await terminalFixture(root, "attention-generation");
	let snapshot = await store.loadSnapshot();
	snapshot.status = "needs_attention";
	snapshot.nodes.done!.status = "failed";
	snapshot.nodes.done!.attempts[0]!.status = "failed";
	await store.saveSnapshot(snapshot);
	await updateHistoryFlag(runs, "attention-generation", "acknowledge");
	assert.equal((await createPrunePlan(runs, ["attention-generation"])).entries[0]?.graphId, "attention-generation");
	snapshot = await store.loadSnapshot();
	snapshot.status = "queued";
	delete snapshot.nodes.done!.attempts[0]!.outputPath;
	delete snapshot.nodes.done!.attempts[0]!.manifestPath;
	await store.saveSnapshot(snapshot);
	snapshot = await store.loadSnapshot();
	snapshot.status = "needs_attention";
	snapshot.error = "second incident";
	await store.saveSnapshot(snapshot);
	await assert.rejects(createPrunePlan(runs, ["attention-generation"]), /current incident has not been acknowledged/);
});

test("acknowledging a legacy v2 attention snapshot binds the migrated attention token", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-attention-migration-"));
	const runs = join(root, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "attention-migration",
		goal: "attention migration",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, root, 20, 2);
	const snapshot = initialSnapshot(graph, root, undefined, 2);
	snapshot.status = "needs_attention";
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const legacy = await store.loadSnapshot();
	assert.equal(legacy.schemaVersion, 2);
	assert.equal(legacy.schemaVersion === 2 ? legacy.attentionAt : undefined, undefined);
	const history = await updateHistoryFlag(runs, graph.graphId, "acknowledge");
	const migrated = await store.loadSnapshot();
	assert.equal(migrated.schemaVersion, 2);
	assert.equal(history.attentionAcknowledgedFor, migrated.schemaVersion === 2 ? migrated.attentionAt : undefined);
});
