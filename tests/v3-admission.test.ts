import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { inspectV3Run } from "../src/v3/inspect.ts";
import { verifyV3Run } from "../src/v3/snapshot.ts";

const CREATED_AT = "2026-03-01T12:00:00.000Z";

function compiledGraph() {
	return compileGraphSpecV3({
		schemaVersion: 3,
		graphId: "admission-test",
		goal: "Exercise V3 admission persistence",
		nodes: [
			{
				taskId: "read",
				agent: "reader",
				task: "Read sources",
				sideEffect: "local_read",
				readScope: [{ kind: "tree", path: "src" }],
			},
			{
				taskId: "write",
				agent: "backend-developer",
				task: "Write result",
				dependsOn: ["read"],
				inputArtifacts: ["admission-test/read/out"],
				sideEffect: "local_write",
				writeScope: [{ kind: "tree", path: "src/generated" }],
				validationCommands: ["npm test"],
			},
		],
	});
}

async function newRun(prefix: string) {
	const root = await mkdtemp(join(tmpdir(), prefix));
	const runDir = join(root, "run-1");
	const initialized = await initializeV3Run({
		runDir,
		graph: compiledGraph(),
		runInstanceId: "run-instance-1",
		sessionId: "session-1",
		supervisorEpoch: "epoch-1",
		createdAt: CREATED_AT,
	});
	return { root, runDir, initialized };
}

async function jsonFile(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

function collectKeys(value: unknown, output = new Set<string>()): Set<string> {
	if (Array.isArray(value)) {
		for (const entry of value) collectKeys(entry, output);
	} else if (typeof value === "object" && value !== null) {
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			output.add(key);
			collectKeys(entry, output);
		}
	}
	return output;
}

async function createGitRepository(path: string, content: string): Promise<void> {
	await mkdir(path, { recursive: true });
	execFileSync("git", ["init", "-q", path]);
	execFileSync("git", ["-C", path, "config", "user.name", "V3 Test"]);
	execFileSync("git", ["-C", path, "config", "user.email", "v3@example.invalid"]);
	await writeFile(join(path, "identity.txt"), content);
	execFileSync("git", ["-C", path, "add", "identity.txt"]);
	execFileSync("git", ["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "identity"]);
}

test("V3 initialization atomically writes snapshot-v3/auth-v4 and inspect verifies the round trip", async (t) => {
	const { root, runDir, initialized } = await newRun("pi-graph-v3-roundtrip-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshot = await jsonFile(join(runDir, "snapshot.json"));
	const authorization = await jsonFile(join(runDir, "authorization.json"));
	assert.equal(snapshot.schemaVersion, 3);
	assert.equal(Object.hasOwn(snapshot, "planningAdmissionId"), false);
	assert.equal(Object.hasOwn(snapshot, "evidenceComplete"), false);
	assert.equal(authorization.schemaVersion, 4);
	assert.equal(authorization.runtimeSchemaVersion, 3);
	assert.deepEqual(Object.keys(authorization).sort(), [
		"createdAt", "graph", "graphDigest", "runInstanceId", "runtimeSchemaVersion", "schemaVersion", "sessionId", "sourceCwd", "sourceGraphSpec", "sourceGraphSpecDigest", "sourceRepository", "supervisorEpoch",
	]);
	assert.deepEqual(verifyV3Run(snapshot, authorization), {
		ok: true,
		reasons: [],
		snapshot: initialized.snapshot,
		authorization: initialized.authorization,
	});
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "ok");
	assert.equal(inspection.format.kind, "v3");
	assert.equal(inspection.graphStatus, "queued");
	assert.deepEqual(inspection.reasons, []);
});

test("V3 serialized admission artifacts contain no planning, routing, model, or persisted completeness fields", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-fields-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const artifacts = [await jsonFile(join(runDir, "snapshot.json")), await jsonFile(join(runDir, "authorization.json"))];
	const forbidden = new Set([
		"planningReceipt", "planningReceiptDigest", "planningBindingDigest", "planningAdmissionId", "routingDecision", "routingProfile", "model", "thinking",
		"resolvedModel", "modelFamily", "providerDomain", "attemptedModels", "modelCandidates", "evidenceComplete",
	]);
	for (const artifact of artifacts) {
		for (const key of collectKeys(artifact)) assert.equal(forbidden.has(key), false, `forbidden serialized key: ${key}`);
	}
});

test("V3 initialization refuses to overwrite an existing run directory", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-existing-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await mkdir(runDir);
	await writeFile(join(runDir, "sentinel.txt"), "keep");
	await assert.rejects(
		initializeV3Run({ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal(await readFile(join(runDir, "sentinel.txt"), "utf8"), "keep");
});

test("V3 initialization failure leaves no recognizable run or temporary artifacts", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-interrupt-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{ atomicRename: async () => { throw new Error("simulated interruption before commit"); } },
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(root), []);
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("MISSING_RUN_DIRECTORY")));
});

test("V3 inspect reports needs_attention when snapshot identity is tampered", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-snapshot-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.graphDigest = "0".repeat(64);
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("IDENTITY_MISMATCH")));
});

test("V3 inspect reports needs_attention when authorization graph bytes are tampered", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-auth-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	const authorization = await jsonFile(authorizationPath);
	const graph = authorization.graph as Record<string, unknown>;
	graph.goal = "tampered goal";
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("compiler projection")));
});

test("V3 inspect recomputes the graph digest instead of trusting persisted digest fields", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-digest-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const authorizationPath = join(runDir, "authorization.json");
	const snapshot = await jsonFile(snapshotPath);
	const authorization = await jsonFile(authorizationPath);
	const forgedDigest = "1".repeat(64);
	authorization.graphDigest = forgedDigest;
	snapshot.graphDigest = forgedDigest;
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("graphDigest")));
});

test("V3 inspect rejects forbidden authorization and snapshot fields at runtime", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-forbidden-runtime-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	const authorization = await jsonFile(authorizationPath);
	authorization.planningReceipt = { schemaVersion: 2 };
	await writeFile(authorizationPath, JSON.stringify(authorization));
	let inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("planningReceipt")));

	delete authorization.planningReceipt;
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.evidenceComplete = true;
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("evidenceComplete")));
});

test("V3 inspect reports mixed authorization versions, corrupt JSON, and missing files", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-invalid-files-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	const authorization = await jsonFile(authorizationPath);
	authorization.schemaVersion = 3;
	await writeFile(authorizationPath, JSON.stringify(authorization));
	let inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.equal(inspection.format.kind, "invalid");

	await writeFile(join(runDir, "snapshot.json"), "{not-json");
	inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("INVALID_JSON")));

	await rm(join(runDir, "snapshot.json"));
	inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("MISSING_FILE")));
});

test("V3 initialization never deletes a competing run directory after rename failure", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-race-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				atomicRename: async (_source, destination) => {
					await mkdir(destination);
					await writeFile(join(destination, "competitor.txt"), "owned by competitor");
					throw new Error("simulated competing publish");
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal(await readFile(join(runDir, "competitor.txt"), "utf8"), "owned by competitor");
	assert.deepEqual(await readdir(root), ["run-1"]);
});

test("V3 inspect rejects symbolic-link authority files and a symbolic-link run root", async (t) => {
	for (const label of ["snapshot.json", "authorization.json"]) {
		const first = await newRun(`pi-graph-v3-symlink-${label}-first-`);
		const second = await newRun(`pi-graph-v3-symlink-${label}-second-`);
		t.after(() => rm(first.root, { recursive: true, force: true }));
		t.after(() => rm(second.root, { recursive: true, force: true }));
		await rm(join(first.runDir, label));
		await symlink(join(second.runDir, label), join(first.runDir, label));
		const inspection = await inspectV3Run(first.runDir);
		assert.equal(inspection.status, "needs_attention");
		assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_FILE")), label);
	}
	const { root, runDir } = await newRun("pi-graph-v3-symlink-root-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const alias = join(root, "run-alias");
	await symlink(runDir, alias);
	const inspection = await inspectV3Run(alias);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_DIRECTORY")));
});

test("V3 inspect rejects directory-shaped authority files", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-nonregular-authority-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	await rm(authorizationPath);
	await mkdir(authorizationPath);
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_FILE")));
});

test("V3 authorization binds the source directory and Git repository identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-source-identity-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const repositoryA = join(root, "repository-a");
	const repositoryB = join(root, "repository-b");
	await createGitRepository(repositoryA, "repository A\n");
	await createGitRepository(repositoryB, "repository B\n");
	const runDirA = join(repositoryA, "runs", "run-1");
	await initializeV3Run({ runDir: runDirA, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", sourceCwd: repositoryA, createdAt: CREATED_AT });
	const originalInspection = await inspectV3Run(runDirA, { sourceCwd: repositoryA });
	assert.equal(originalInspection.status, "ok");
	const runDirB = join(repositoryB, "runs", "run-1");
	await mkdir(join(repositoryB, "runs"), { recursive: true });
	await cp(runDirA, runDirB, { recursive: true });
	const copiedInspection = await inspectV3Run(runDirB, { sourceCwd: repositoryB });
	assert.equal(copiedInspection.status, "needs_attention");
	assert.ok(copiedInspection.reasons.some((reason) => reason.includes("SOURCE_IDENTITY_MISMATCH")));
});

test("V3 inspect rejects an initialization snapshot whose status was changed to complete", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-status-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.status = "complete";
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("STATUS_MISMATCH")));
});

test("V3 initialization takes over a lock owned by a dead process identity", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-stale-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, processIdentity: "ps:dead process", token: "stale-token", createdAt: CREATED_AT }));
	await initializeV3Run({ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT });
	assert.equal((await inspectV3Run(runDir)).status, "ok");
	assert.deepEqual(await readdir(root), ["run-1"]);
});

test("V3 initialization rejects a damaged lock identity instead of guessing ownership", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-invalid-lock-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: "missing-process-identity", createdAt: CREATED_AT }));
	await assert.rejects(
		initializeV3Run({ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.deepEqual(await readdir(lockDir), ["owner.json"]);
});

test("V3 inspect recomputes sourceGraphSpecDigest from persisted source material", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-source-digest-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const authorizationPath = join(runDir, "authorization.json");
	const snapshot = await jsonFile(snapshotPath);
	const authorization = await jsonFile(authorizationPath);
	const forgedDigest = "2".repeat(64);
	snapshot.sourceGraphSpecDigest = forgedDigest;
	authorization.sourceGraphSpecDigest = forgedDigest;
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("sourceGraphSpecDigest")));
});

test("V3 inspect rejects authorization missing source GraphSpec material", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-source-material-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	const authorization = await jsonFile(authorizationPath);
	delete authorization.sourceGraphSpec;
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const inspection = await inspectV3Run(runDir);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("sourceGraphSpec")));
});

test("V3 initialization fsyncs the committed run directory and its parent", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-v3-fsync-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const synced: string[] = [];
	await initializeV3Run(
		{ runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ syncDirectory: async (path) => { synced.push(path); } },
	);
	assert.deepEqual(synced.slice(-2), [runDir, root]);
});
