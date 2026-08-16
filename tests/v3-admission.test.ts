import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { inspectV3Run } from "../src/v3/inspect.ts";
import { verifyV3Run } from "../src/v3/snapshot.ts";
import { resolveSourceIdentityV3 } from "../src/v3/source-identity.ts";

const CREATED_AT = "2026-03-01T12:00:00.000Z";

async function canonicalTempRoot(prefix: string): Promise<string> {
	return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

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
	const root = await canonicalTempRoot(prefix);
	const runDir = join(root, "run-1");
	const initialized = await initializeV3Run({
		trustedRoot: root,
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

test("V3 initialization exclusively claims a run and durably writes snapshot-v3/auth-v4", async (t) => {
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
	assert.deepEqual(verifyV3Run(snapshot, authorization, {
		sourceCwd: initialized.authorization.sourceCwd,
		sourceRepository: initialized.authorization.sourceRepository,
	}), {
		ok: true,
		reasons: [],
		snapshot: initialized.snapshot,
		authorization: initialized.authorization,
	});
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	const root = await canonicalTempRoot("pi-graph-v3-existing-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await mkdir(runDir);
	await writeFile(join(runDir, "sentinel.txt"), "keep");
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal(await readFile(join(runDir, "sentinel.txt"), "utf8"), "keep");
});

test("V3 initialization preserves a dangling run-directory symbolic link", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-dangling-target-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const missingTarget = join(root, "missing-target");
	await symlink(missingTarget, runDir);
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal((await lstat(runDir)).isSymbolicLink(), true);
});

test("V3 initialization failure leaves no recognizable run or temporary artifacts", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-interrupt-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{ beforePublish: async () => { throw new Error("simulated interruption before commit"); } },
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(root), []);
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	let inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("planningReceipt")));

	delete authorization.planningReceipt;
	await writeFile(authorizationPath, JSON.stringify(authorization));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.evidenceComplete = true;
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	let inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.equal(inspection.format.kind, "invalid");

	await writeFile(join(runDir, "snapshot.json"), "{not-json");
	inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("INVALID_JSON")));

	await rm(join(runDir, "snapshot.json"));
	inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("MISSING_FILE")));
});

test("V3 initialization never deletes a competing non-empty run directory at publication", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				beforePublish: async () => {
					await mkdir(runDir);
					await writeFile(join(runDir, "competitor.txt"), "owned by competitor");
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal(await readFile(join(runDir, "competitor.txt"), "utf8"), "owned by competitor");
	assert.deepEqual(await readdir(root), ["run-1"]);
});

test("V3 initialization preserves a competing empty run directory and its identity", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-empty-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	let competitorIdentity: { dev: number; ino: number } | undefined;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				beforePublish: async () => {
					await mkdir(runDir);
					const stat = await lstat(runDir);
					competitorIdentity = { dev: stat.dev, ino: stat.ino };
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	const finalStat = await lstat(runDir);
	assert.deepEqual({ dev: finalStat.dev, ino: finalStat.ino }, competitorIdentity);
	assert.deepEqual(await readdir(runDir), []);
});

test("V3 initialization classifies competing file and dangling-link targets as existing runs", async (t) => {
	for (const targetKind of ["file", "dangling-link"] as const) {
		await t.test(targetKind, async (t) => {
			const root = await canonicalTempRoot(`pi-graph-v3-${targetKind}-race-`);
			t.after(() => rm(root, { recursive: true, force: true }));
			const runDir = join(root, "run-1");
			await assert.rejects(
				initializeV3Run(
					{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
					{
						beforePublish: async () => {
							if (targetKind === "file") await writeFile(runDir, "competitor");
							else await symlink(join(root, "missing-target"), runDir);
						},
					},
				),
				(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
			);
			const stat = await lstat(runDir);
			if (targetKind === "file") {
				assert.equal(stat.isFile(), true);
				assert.equal(await readFile(runDir, "utf8"), "competitor");
			} else {
				assert.equal(stat.isSymbolicLink(), true);
			}
			assert.deepEqual(await readdir(root), ["run-1"]);
		});
	}
});

test("V3 inspect rejects symbolic-link authority files and a symbolic-link run root", async (t) => {
	for (const label of ["snapshot.json", "authorization.json"]) {
		const first = await newRun(`pi-graph-v3-symlink-${label}-first-`);
		const second = await newRun(`pi-graph-v3-symlink-${label}-second-`);
		t.after(() => rm(first.root, { recursive: true, force: true }));
		t.after(() => rm(second.root, { recursive: true, force: true }));
		await rm(join(first.runDir, label));
		await symlink(join(second.runDir, label), join(first.runDir, label));
		const inspection = await inspectV3Run(first.runDir, { trustedRoot: first.root });
		assert.equal(inspection.status, "needs_attention");
		assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_FILE")), label);
	}
	const { root, runDir } = await newRun("pi-graph-v3-symlink-root-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const alias = join(root, "run-alias");
	await symlink(runDir, alias);
	const inspection = await inspectV3Run(alias, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_DIRECTORY")));
});

test("V3 initialize and inspect reject a symbolic-link runs parent", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-symlink-parent-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const realRuns = join(root, "real-runs");
	const linkedRuns = join(root, "linked-runs");
	await mkdir(realRuns);
	await symlink(realRuns, linkedRuns);
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir: join(linkedRuns, "blocked"), graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(realRuns), []);
	const realRun = join(realRuns, "existing");
	await initializeV3Run({ trustedRoot: root, runDir: realRun, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT });
	const inspection = await inspectV3Run(join(linkedRuns, "existing"), { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_PARENT")));
});

test("V3 initialize and inspect reject a symbolic-link ancestor below the trusted root", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-symlink-ancestor-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const realRoot = join(root, "real");
	const aliasRoot = join(root, "alias");
	const realRuns = join(realRoot, "nested", "runs");
	await mkdir(realRuns, { recursive: true });
	await symlink(realRoot, aliasRoot);
	const aliasedRun = join(aliasRoot, "nested", "runs", "blocked");
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir: aliasedRun, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(realRuns), []);
	const realRun = join(realRuns, "existing");
	await initializeV3Run({ trustedRoot: root, runDir: realRun, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT });
	const inspection = await inspectV3Run(join(aliasRoot, "nested", "runs", "existing"), { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_PARENT")));
});

test("V3 path checks treat backslashes as filename characters on POSIX", async (t) => {
	if (sep !== "/") {
		t.skip("POSIX filename semantics only");
		return;
	}
	const root = await canonicalTempRoot("pi-graph-v3-backslash-link-");
	const outside = `${root}-outside`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(outside, { recursive: true, force: true }));
	await mkdir(join(outside, "nested"), { recursive: true });
	const alias = join(root, "alias\\name");
	await symlink(outside, alias);
	const runDir = join(alias, "nested", "run-1");
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(join(outside, "nested")), []);
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_PARENT")));
});

test("V3 initialize and inspect reject run paths outside the trusted root", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-trusted-root-escape-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const trustedRoot = join(root, "trusted");
	const outside = join(root, "outside");
	await mkdir(trustedRoot);
	await mkdir(outside);
	const runDir = join(trustedRoot, "..", "outside", "run-1");
	await assert.rejects(
		initializeV3Run({ trustedRoot, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(outside), []);
	const inspection = await inspectV3Run(runDir, { trustedRoot });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_PARENT")));
});

test("V3 initialization pins the trusted-root identity across lock acquisition", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-trusted-root-replaced-");
	const originalRoot = `${root}-original`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(originalRoot, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	let replacementLockWasSynced = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => {
					await rename(root, originalRoot);
					await mkdir(root);
					return "current-process";
				},
				syncDirectory: async (path) => {
					if (path === lockDir) replacementLockWasSynced = true;
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(replacementLockWasSynced, false);
	assert.deepEqual(await readdir(root), []);
	assert.deepEqual(await readdir(originalRoot), []);
});

test("V3 initialization rechecks the trusted root after inspecting a stale lock owner", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-root-replaced-during-owner-check-");
	const originalRoot = `${root}-original`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(originalRoot, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const owner = { schemaVersion: 1, pid: process.pid, processIdentity: "older-process-incarnation", token: "older-token", createdAt: CREATED_AT };
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify(owner));
	let identityCalls = 0;
	let replacementLockWasSynced = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => {
					identityCalls += 1;
					if (identityCalls === 1) return "current-process";
					await rename(root, originalRoot);
					await mkdir(root);
					return "reused-pid-process";
				},
				syncDirectory: async (path) => {
					if (path === lockDir) replacementLockWasSynced = true;
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(identityCalls, 2);
	assert.equal(replacementLockWasSynced, false);
	assert.deepEqual(await readdir(root), []);
	assert.deepEqual(await jsonFile(join(originalRoot, ".run-1.initialize-lock", "owner.json")), owner);
});

test("V3 initialization captures the trusted-root identity before resolving the source", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-root-before-source-");
	const originalRoot = `${root}-original`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(originalRoot, { recursive: true, force: true }));
	const sourceIdentity = await resolveSourceIdentityV3(process.cwd());
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				sourceIdentityFor: async () => {
					await rename(root, originalRoot);
					await mkdir(root);
					return sourceIdentity;
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await readdir(root), []);
	assert.deepEqual(await readdir(originalRoot), []);
});

test("V3 initialization stops creating parents when the trusted root is replaced during directory sync", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-root-replaced-during-parent-sync-");
	const originalRoot = `${root}-original`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(originalRoot, { recursive: true, force: true }));
	const firstParent = join(root, "new");
	const runDir = join(firstParent, "runs", "run-1");
	let replaced = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				syncDirectory: async (path) => {
					if (path !== firstParent || replaced) return;
					replaced = true;
					await rename(root, originalRoot);
					await mkdir(root);
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(replaced, true);
	assert.deepEqual(await readdir(root), []);
	assert.deepEqual(await readdir(originalRoot), ["new"]);
	assert.deepEqual(await readdir(join(originalRoot, "new")), []);
});

test("V3 inspect rejects directory-shaped authority files", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-nonregular-authority-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const authorizationPath = join(runDir, "authorization.json");
	await rm(authorizationPath);
	await mkdir(authorizationPath);
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_FILE")));
});

test("V3 inspect rechecks the run boundary after asynchronous source identity resolution", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-inspect-source-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runsDir = join(root, "runs");
	const originalRunsDir = join(root, "runs-original");
	const runDir = join(runsDir, "run-1");
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ processIdentityForPid: async () => "current-process" },
	);
	const sourceIdentity = await resolveSourceIdentityV3(process.cwd());
	let swapped = false;
	const inspection = await inspectV3Run(
		runDir,
		{ trustedRoot: root },
		{
			sourceIdentityFor: async () => {
				await rename(runsDir, originalRunsDir);
				await symlink(originalRunsDir, runsDir);
				swapped = true;
				return sourceIdentity;
			},
		},
	);
	assert.equal(swapped, true);
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_RUN_DIRECTORY")));
	assert.equal((await lstat(runsDir)).isSymbolicLink(), true);
	assert.equal((await lstat(join(originalRunsDir, "run-1"))).isDirectory(), true);
});

test("V3 inspect rejects authority rewrites during asynchronous source identity resolution", async (t) => {
	for (const label of ["authorization.json", "snapshot.json"] as const) {
		await t.test(label, async (t) => {
			const root = await canonicalTempRoot(`pi-graph-v3-inspect-${label}-source-race-`);
			t.after(() => rm(root, { recursive: true, force: true }));
			const runDir = join(root, "run-1");
			await initializeV3Run(
				{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
				{ processIdentityForPid: async () => "current-process" },
			);
			const sourceIdentity = await resolveSourceIdentityV3(process.cwd());
			let rewritten = false;
			const inspection = await inspectV3Run(
				runDir,
				{ trustedRoot: root },
				{
					sourceIdentityFor: async () => {
						await writeFile(join(runDir, label), "{tampered");
						rewritten = true;
						return sourceIdentity;
					},
				},
			);
			assert.equal(rewritten, true);
			assert.equal(inspection.status, "needs_attention");
			assert.ok(inspection.reasons.some((reason) => reason.includes("UNSAFE_FILE")));
		});
	}
});

test("V3 inspect snapshots caller options and resolved source identity at its async boundary", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-inspect-entry-snapshot-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ processIdentityForPid: async () => "current-process" },
	);
	const sourceAtEntry = process.cwd();
	const options = { trustedRoot: root, sourceCwd: sourceAtEntry };
	const resolvedIdentity = await resolveSourceIdentityV3(sourceAtEntry);
	let returnedIdentityWasMutated = false;
	const inspectionPromise = inspectV3Run(runDir, options, {
		sourceIdentityFor: async (sourceCwd) => {
			assert.equal(sourceCwd, sourceAtEntry);
			setImmediate(() => {
				resolvedIdentity.sourceCwd = root;
				returnedIdentityWasMutated = true;
			});
			return resolvedIdentity;
		},
	});
	options.sourceCwd = root;
	const inspection = await inspectionPromise;
	assert.equal(returnedIdentityWasMutated, true);
	assert.equal(inspection.status, "ok");
});

test("V3 authorization binds a stable repository identity without binding mutable Git HEAD", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-source-identity-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const repositoryA = join(root, "repository-a");
	const repositoryB = join(root, "repository-b");
	await createGitRepository(repositoryA, "repository A\n");
	await createGitRepository(repositoryB, "repository B\n");
	const runDirA = join(repositoryA, "runs", "run-1");
	await initializeV3Run({ trustedRoot: root, runDir: runDirA, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", sourceCwd: repositoryA, createdAt: CREATED_AT });
	const originalInspection = await inspectV3Run(runDirA, { trustedRoot: root, sourceCwd: repositoryA });
	assert.equal(originalInspection.status, "ok");
	await writeFile(join(repositoryA, "identity.txt"), "repository A, second commit\n");
	execFileSync("git", ["-C", repositoryA, "add", "identity.txt"]);
	execFileSync("git", ["-C", repositoryA, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "second identity"]);
	assert.equal((await inspectV3Run(runDirA, { trustedRoot: root, sourceCwd: repositoryA })).status, "ok");
	const runDirB = join(repositoryB, "runs", "run-1");
	await mkdir(join(repositoryB, "runs"), { recursive: true });
	await cp(runDirA, runDirB, { recursive: true });
	const copiedInspection = await inspectV3Run(runDirB, { trustedRoot: root, sourceCwd: repositoryB });
	assert.equal(copiedInspection.status, "needs_attention");
	assert.ok(copiedInspection.reasons.some((reason) => reason.includes("SOURCE_IDENTITY_MISMATCH")));
});

test("V3 authorization rejects a non-Git source directory recreated at the same path", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-directory-identity-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCwd = join(root, "source");
	const runDir = join(root, "runs", "run-1");
	await mkdir(sourceCwd);
	await initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", sourceCwd, createdAt: CREATED_AT });
	assert.equal((await inspectV3Run(runDir, { trustedRoot: root, sourceCwd })).status, "ok");
	await rm(sourceCwd, { recursive: true });
	await mkdir(sourceCwd);
	const inspection = await inspectV3Run(runDir, { trustedRoot: root, sourceCwd });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("SOURCE_IDENTITY_MISMATCH")));
});

test("V3 initialization fails closed on a broken Git worktree marker", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-broken-git-marker-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourceCwd = join(root, "source");
	await mkdir(sourceCwd);
	await writeFile(join(sourceCwd, ".git"), "gitdir: ../missing-git-directory\n");
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir: join(root, "runs", "run-1"), graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", sourceCwd, createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
});

test("V3 initialization snapshots the compiled graph before asynchronous lock acquisition", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-immutable-admission-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const graph = compiledGraph();
	const originalTask = graph.nodes[0]!.task;
	const runDir = join(root, "run-1");
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph, sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ processIdentityForPid: async () => {
			graph.nodes[0]!.task = "mutated after admission";
			return "test-process-identity";
		} },
	);
	const authorization = await jsonFile(join(runDir, "authorization.json"));
	const nodes = (authorization.graph as { nodes: Array<{ task: string }> }).nodes;
	assert.equal(nodes[0]!.task, originalTask);
	assert.equal((await inspectV3Run(runDir, { trustedRoot: root })).status, "ok");
});

test("V3 initialization snapshots caller-owned admission inputs before source identity awaits", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-entry-snapshot-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const graph = compiledGraph();
	const originalTask = graph.nodes[0]!.task;
	const options = {
		trustedRoot: root,
		runDir: join(root, "run-1"),
		graph,
		sessionId: "session-at-entry",
		supervisorEpoch: "epoch-at-entry",
		createdAt: CREATED_AT,
	};
	const sourceIdentity = await resolveSourceIdentityV3(process.cwd());
	await initializeV3Run(options, {
		sourceIdentityFor: async () => {
			options.graph.nodes[0]!.task = "mutated while source identity was pending";
			options.sessionId = "mutated-session";
			options.supervisorEpoch = "mutated-epoch";
			return sourceIdentity;
		},
		processIdentityForPid: async () => "current-process",
	});
	const authorization = await jsonFile(join(options.runDir, "authorization.json"));
	const snapshot = await jsonFile(join(options.runDir, "snapshot.json"));
	const nodes = (authorization.graph as { nodes: Array<{ task: string }> }).nodes;
	assert.equal(nodes[0]!.task, originalTask);
	assert.equal(authorization.sessionId, "session-at-entry");
	assert.equal(authorization.supervisorEpoch, "epoch-at-entry");
	assert.equal(snapshot.sessionId, "session-at-entry");
	assert.equal(snapshot.supervisorEpoch, "epoch-at-entry");
	assert.equal((await inspectV3Run(options.runDir, { trustedRoot: root })).status, "ok");
});

test("V3 initialization never follows a replaced staging directory outside the trusted root", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-staging-replaced-");
	const external = await canonicalTempRoot("pi-graph-v3-staging-external-");
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(external, { recursive: true, force: true }));
	const externalAuthorization = join(external, "authorization.json");
	const externalSnapshot = join(external, "snapshot.json");
	await writeFile(externalAuthorization, "external authorization\n");
	await writeFile(externalSnapshot, "external snapshot\n");
	const authorizationBefore = await lstat(externalAuthorization);
	const snapshotBefore = await lstat(externalSnapshot);
	const runDir = join(root, "run-1");
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				beforePublish: async () => {
					const stagingName = (await readdir(root)).find((name) => name.startsWith(".run-1.tmp-"));
					assert.ok(stagingName);
					const staging = join(root, stagingName);
					await rename(staging, `${staging}.original`);
					await symlink(external, staging);
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(await readFile(externalAuthorization, "utf8"), "external authorization\n");
	assert.equal(await readFile(externalSnapshot, "utf8"), "external snapshot\n");
	const authorizationAfter = await lstat(externalAuthorization);
	const snapshotAfter = await lstat(externalSnapshot);
	assert.deepEqual({ dev: authorizationAfter.dev, ino: authorizationAfter.ino }, { dev: authorizationBefore.dev, ino: authorizationBefore.ino });
	assert.deepEqual({ dev: snapshotAfter.dev, ino: snapshotAfter.ino }, { dev: snapshotBefore.dev, ino: snapshotBefore.ino });
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 initialization rejects in-place staging authority rewrites", async (t) => {
	for (const label of ["authorization.json", "snapshot.json"] as const) {
		await t.test(label, async (t) => {
			const root = await canonicalTempRoot(`pi-graph-v3-staging-${label}-rewrite-`);
			t.after(() => rm(root, { recursive: true, force: true }));
			const runDir = join(root, "run-1");
			await assert.rejects(
				initializeV3Run(
					{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
					{
						processIdentityForPid: async () => "current-process",
						beforePublish: async () => {
							const stagingName = (await readdir(root)).find((name) => name.startsWith(".run-1.tmp-"));
							assert.ok(stagingName);
							await writeFile(join(root, stagingName, label), "{tampered");
						},
					},
				),
				(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
			);
			assert.deepEqual(await readdir(root), []);
		});
	}
});

test("V3 inspect rejects an initialization snapshot whose status was changed to complete", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-status-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.status = "complete";
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("STATUS_MISMATCH")));
});

test("V3 inspect rejects an initialization snapshot whose updatedAt was changed", async (t) => {
	const { root, runDir } = await newRun("pi-graph-v3-updated-at-tamper-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const snapshotPath = join(runDir, "snapshot.json");
	const snapshot = await jsonFile(snapshotPath);
	snapshot.updatedAt = "2026-03-01T12:00:01.000Z";
	await writeFile(snapshotPath, JSON.stringify(snapshot));
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("UPDATED_AT_MISMATCH")));
});

test("V3 initialization takes over a lock owned by a dead process identity", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-stale-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, processIdentity: "ps:dead process", token: "stale-token", createdAt: CREATED_AT }));
	await initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT });
	assert.equal((await inspectV3Run(runDir, { trustedRoot: root })).status, "ok");
	assert.deepEqual(await readdir(root), ["run-1"]);
});

test("V3 initialization verifies its lock identity after publishing the owner", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-lock-publication-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const displacedLock = join(root, ".run-1.displaced-lock");
	const competitorOwner = { schemaVersion: 1, pid: process.pid, processIdentity: "competitor-process", token: "competitor-token", createdAt: CREATED_AT };
	let swapped = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				syncDirectory: async (path) => {
					if (path !== lockDir || swapped) return;
					swapped = true;
					await rename(lockDir, displacedLock);
					await mkdir(lockDir);
					await writeFile(join(lockDir, "owner.json"), JSON.stringify(competitorOwner));
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(swapped, true);
	assert.deepEqual(await jsonFile(join(lockDir, "owner.json")), competitorOwner);
	assert.equal((await lstat(displacedLock)).isDirectory(), true);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 initialization keeps the same lock identity through run publication", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-lock-lost-before-publish-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const displacedLock = join(root, ".run-1.displaced-lock");
	const competitorOwner = { schemaVersion: 1, pid: process.pid, processIdentity: "competitor-process", token: "competitor-token", createdAt: CREATED_AT };
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				beforePublish: async () => {
					await rename(lockDir, displacedLock);
					await mkdir(lockDir);
					await writeFile(join(lockDir, "owner.json"), JSON.stringify(competitorOwner));
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.deepEqual(await jsonFile(join(lockDir, "owner.json")), competitorOwner);
	assert.equal((await lstat(displacedLock)).isDirectory(), true);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 stale takeover never moves a newer active lock published during owner inspection", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-stale-takeover-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const displacedLock = join(root, ".run-1.older-lock");
	const olderOwner = { schemaVersion: 1, pid: process.pid, processIdentity: "older-process", token: "older-token", createdAt: CREATED_AT };
	const competitorOwner = { schemaVersion: 1, pid: process.pid, processIdentity: "competitor-process", token: "competitor-token", createdAt: CREATED_AT };
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify(olderOwner));
	let identityCalls = 0;
	let swapped = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => {
					identityCalls += 1;
					if (identityCalls === 1) return "current-process";
					if (!swapped) {
						swapped = true;
						await rename(lockDir, displacedLock);
						await mkdir(lockDir);
						await writeFile(join(lockDir, "owner.json"), JSON.stringify(competitorOwner));
						return "reused-pid-process";
					}
					return "competitor-process";
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "RUN_ALREADY_EXISTS",
	);
	assert.equal(swapped, true);
	assert.deepEqual(await jsonFile(join(lockDir, "owner.json")), competitorOwner);
	assert.deepEqual(await jsonFile(join(displacedLock, "owner.json")), olderOwner);
	assert.equal((await readdir(root)).some((name) => name.startsWith(".run-1.initialize-lock.stale-")), false);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 initialization rejects a damaged lock identity instead of guessing ownership", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-invalid-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: 99_999_999, token: "missing-process-identity", createdAt: CREATED_AT }));
	await assert.rejects(
		initializeV3Run({ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT }),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.deepEqual(await readdir(lockDir), ["owner.json"]);
});

test("V3 initialization never age-recovers a damaged published lock even when its PID is live", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-expired-damaged-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const ownerPath = join(lockDir, "owner.json");
	const owner = JSON.stringify({ schemaVersion: 1, pid: process.pid, token: "missing-process-identity", createdAt: CREATED_AT });
	await mkdir(lockDir);
	await writeFile(ownerPath, owner);
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(ownerPath, old, old);
	await utimes(lockDir, old, old);
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{ processIdentityForPid: async () => "current-process" },
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.equal(await readFile(ownerPath, "utf8"), owner);
	assert.equal((await lstat(lockDir)).isDirectory(), true);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 initialization fails closed when a live lock owner identity is unavailable", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-unobservable-live-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	await writeFile(join(lockDir, "owner.json"), JSON.stringify({ schemaVersion: 1, pid: process.ppid, processIdentity: "unobservable-live-process", token: "live-token", createdAt: CREATED_AT }));
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{ processIdentityForPid: async (pid) => pid === process.pid ? "current-process" : undefined },
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.deepEqual(await readdir(lockDir), ["owner.json"]);
});

test("V3 initialization recovers an expired ownerless lock left before owner publication", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-expired-incomplete-lock-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(lockDir, old, old);
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ processIdentityForPid: async () => "current-process" },
	);
	assert.equal((await inspectV3Run(runDir, { trustedRoot: root })).status, "ok");
	assert.deepEqual(await readdir(root), ["run-1"]);
});

test("V3 initialization leaves an expired ownerless lock canonical when its creator publishes before quarantine", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-ownerless-lock-revived-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const owner = { schemaVersion: 1, pid: process.pid, processIdentity: "revived-process", token: "revived-token", createdAt: CREATED_AT };
	await mkdir(lockDir);
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(lockDir, old, old);
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				beforeOwnerlessLockCleanup: async (path) => {
					assert.equal(path, lockDir);
					await writeFile(join(path, "owner.json"), JSON.stringify(owner));
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.deepEqual(await jsonFile(join(lockDir, "owner.json")), owner);
	assert.equal((await readdir(root)).some((name) => name.startsWith(".run-1.initialize-lock.ownerless-")), false);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 ownerless recovery never quarantines a newer active lock published during cleanup", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-ownerless-recovery-race-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	const displacedLock = join(root, ".run-1.abandoned-ownerless-lock");
	const competitorOwner = { schemaVersion: 1, pid: process.pid, processIdentity: "competitor-process", token: "competitor-token", createdAt: CREATED_AT };
	await mkdir(lockDir);
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(lockDir, old, old);
	let swapped = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				beforeOwnerlessLockCleanup: async () => {
					swapped = true;
					await rename(lockDir, displacedLock);
					await mkdir(lockDir);
					await writeFile(join(lockDir, "owner.json"), JSON.stringify(competitorOwner));
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INVALID_INITIALIZATION_LOCK",
	);
	assert.equal(swapped, true);
	assert.deepEqual(await jsonFile(join(lockDir, "owner.json")), competitorOwner);
	assert.deepEqual(await readdir(displacedLock), []);
	assert.equal((await readdir(root)).some((name) => name.startsWith(".run-1.initialize-lock.ownerless-")), false);
	await assert.rejects(lstat(runDir), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("V3 ownerless recovery preserves the original lock when its trusted root is replaced", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-ownerless-root-replaced-");
	const originalRoot = `${root}-original`;
	t.after(() => rm(root, { recursive: true, force: true }));
	t.after(() => rm(originalRoot, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const lockDir = join(root, ".run-1.initialize-lock");
	await mkdir(lockDir);
	const old = new Date(Date.now() - 10 * 60_000);
	await utimes(lockDir, old, old);
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				beforeOwnerlessLockCleanup: async () => {
					await rename(root, originalRoot);
					await symlink(originalRoot, root);
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal((await lstat(root)).isSymbolicLink(), true);
	assert.equal((await lstat(join(originalRoot, ".run-1.initialize-lock"))).isDirectory(), true);
	assert.deepEqual(await readdir(join(originalRoot, ".run-1.initialize-lock")), []);
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
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
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
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("sourceGraphSpec")));
});

test("V3 initialization fsyncs the committed run directory and its parent", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-fsync-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const synced: string[] = [];
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{ syncDirectory: async (path) => { synced.push(path); } },
	);
	assert.deepEqual(synced.slice(-2), [runDir, root]);
});

test("V3 initialization cleans up its own published run when final durability fails", async (t) => {
	for (const failurePoint of ["run", "parent"] as const) {
		await t.test(failurePoint, async (t) => {
			const root = await canonicalTempRoot(`pi-graph-v3-${failurePoint}-fsync-failure-`);
			t.after(() => rm(root, { recursive: true, force: true }));
			const runDir = join(root, "run-1");
			let runSynced = false;
			await assert.rejects(
				initializeV3Run(
					{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
					{
						processIdentityForPid: async () => "current-process",
						syncDirectory: async (path) => {
							if (path === runDir) {
								runSynced = true;
								if (failurePoint === "run") throw new Error("simulated run fsync failure");
							}
							if (failurePoint === "parent" && runSynced && path === root) throw new Error("simulated parent fsync failure");
						},
					},
				),
				(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
			);
			assert.deepEqual(await readdir(root), []);
			const inspection = await inspectV3Run(runDir, { trustedRoot: root });
			assert.equal(inspection.status, "needs_attention");
			assert.ok(inspection.reasons.some((reason) => reason.includes("MISSING_RUN_DIRECTORY")));
		});
	}
});

test("V3 initialization fails closed without deleting a replacement of its published run", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-published-run-replaced-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const runDir = join(root, "run-1");
	const displacedRun = join(root, "displaced-run");
	let swapped = false;
	await assert.rejects(
		initializeV3Run(
			{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
			{
				processIdentityForPid: async () => "current-process",
				syncDirectory: async (path) => {
					if (path !== runDir || swapped) return;
					swapped = true;
					await rename(runDir, displacedRun);
					await mkdir(runDir);
					await writeFile(join(runDir, "competitor.txt"), "owned by competitor");
				},
			},
		),
		(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
	);
	assert.equal(swapped, true);
	assert.equal(await readFile(join(runDir, "competitor.txt"), "utf8"), "owned by competitor");
	assert.deepEqual((await readdir(displacedRun)).sort(), ["authorization.json", "snapshot.json"]);
	const inspection = await inspectV3Run(runDir, { trustedRoot: root });
	assert.equal(inspection.status, "needs_attention");
	assert.ok(inspection.reasons.some((reason) => reason.includes("MISSING_FILE")));
});

test("V3 initialization rejects authority bytes rewritten during final run sync", async (t) => {
	for (const label of ["authorization.json", "snapshot.json"] as const) {
		await t.test(label, async (t) => {
			const root = await canonicalTempRoot(`pi-graph-v3-final-${label}-rewrite-`);
			t.after(() => rm(root, { recursive: true, force: true }));
			const runDir = join(root, "run-1");
			let rewritten = false;
			await assert.rejects(
				initializeV3Run(
					{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
					{
						processIdentityForPid: async () => "current-process",
						syncDirectory: async (path) => {
							if (path !== runDir || rewritten) return;
							rewritten = true;
							await writeFile(join(runDir, label), "{tampered");
						},
					},
				),
				(error: unknown) => error instanceof GraphV3Error && error.code === "INITIALIZATION_FAILED",
			);
			assert.equal(rewritten, true);
			assert.deepEqual(await readdir(root), []);
		});
	}
});

test("V3 initialization durably creates every missing runs-parent directory", async (t) => {
	const root = await canonicalTempRoot("pi-graph-v3-new-parent-fsync-");
	t.after(() => rm(root, { recursive: true, force: true }));
	const parentDir = join(root, "new", "runs");
	const runDir = join(parentDir, "run-1");
	const synced: string[] = [];
	await initializeV3Run(
		{ trustedRoot: root, runDir, graph: compiledGraph(), sessionId: "session", supervisorEpoch: "epoch", createdAt: CREATED_AT },
		{
			processIdentityForPid: async () => "current-process",
			syncDirectory: async (path) => { synced.push(path); },
		},
	);
	assert.ok(synced.includes(root), "the existing ancestor must be fsynced after publishing its new child");
	assert.ok(synced.includes(join(root, "new")), "each newly created directory must be fsynced");
	assert.ok(synced.includes(parentDir), "the runs parent must be fsynced");
	assert.deepEqual(synced.slice(-2), [runDir, parentDir]);
});
