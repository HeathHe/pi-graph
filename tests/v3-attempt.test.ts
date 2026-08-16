import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	readLatestV3Attempt,
	readV3AcceptanceEvidence,
	readV3AttemptEvidence,
	readV3ValidatedResult,
	readV3WorkspaceEvidence,
	validateV3Attempt,
	v3AttemptEvidenceDigest,
	writeV3AcceptanceEvidence,
	writeV3AttemptEvidence,
	writeV3ValidatedResult,
	writeV3WorkspaceEvidence,
} from "../src/v3/attempt.ts";
import { GraphV3Error } from "../src/v3/errors.ts";
import { v3ReadyNodes, v3PendingNodes, v3GraphBlocked } from "../src/v3/scheduler.ts";
import type { CompiledGraphV3, V3AttemptEvidence, V3WorkspaceEvidence } from "../src/v3/types.ts";

function evidence(taskId: string, attempt: number, phase: V3AttemptEvidence["phase"]): V3AttemptEvidence {
	const now = new Date().toISOString();
	return {
		schemaVersion: 1,
		runInstanceId: "r1",
		graphId: "g1",
		taskId,
		attempt,
		attemptNonce: `nonce-${taskId}-${attempt}`,
		phase,
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: "epoch",
	};
}

test("V3 attempt evidence round-trips and validates terminal invariants", async () => {
	const dir = await mkdtemp(join(tmpdir(), "v3-attempt-"));
	const prepared = evidence("a", 1, "prepared");
	const digest = await writeV3AttemptEvidence(dir, "a", 1, prepared);
	assert.match(digest, /^[a-f0-9]{64}$/);
	const read = await readV3AttemptEvidence(dir, "a", 1);
	assert.deepEqual(read, prepared);
	assert.equal(v3AttemptEvidenceDigest(prepared), digest);
	const latest = await readLatestV3Attempt(dir, "a");
	assert.equal(latest!.attempt, 1);
	// A terminal phase requires terminalStatus.
	assert.throws(() => validateV3Attempt(evidence("a", 1, "accepted")), GraphV3Error);
	// A non-terminal phase must omit terminalStatus.
	assert.throws(() => validateV3Attempt({ ...evidence("a", 1, "prepared"), terminalStatus: "accepted" as const }), GraphV3Error);
	// Unknown fields are rejected.
	assert.throws(() => validateV3Attempt({ ...evidence("a", 1, "prepared"), extra: 1 }), GraphV3Error);
});

test("V3 attempt evidence digest chain links workspace, validated-result, and acceptance", async () => {
	const dir = await mkdtemp(join(tmpdir(), "v3-attempt-"));
	const attempt = evidence("a", 1, "accepted");
	const workspace: V3WorkspaceEvidence = {
		schemaVersion: 1,
		runInstanceId: "r1",
		graphId: "g1",
		taskId: "a",
		attempt: 1,
		workspaceKind: "shadow",
		workspaceDir: join(dir, "shadow"),
		sourceCwd: join(dir, "source"),
		readBaseline: {},
		writeBaseline: { "/tmp/source/out.txt": null },
		inputBaseline: {},
		contractDigest: "c",
		createdAt: new Date().toISOString(),
	};
	const workspaceDigest = await writeV3WorkspaceEvidence(dir, "a", 1, workspace);
	const validated = {
		schemaVersion: 1 as const,
		runInstanceId: "r1",
		graphId: "g1",
		taskId: "a",
		attempt: 1,
		validations: [{ command: "test -f out.txt", ok: true, exitCode: 0, signal: null, timedOut: false, stdout: "", stdoutTruncated: false, stderr: "", stderrTruncated: false, durationMs: 1 }],
		allPassed: true,
		writes: [],
		recordedAt: new Date().toISOString(),
	};
	const validatedDigest = await writeV3ValidatedResult(dir, "a", 1, validated);
	const withLinks = { ...attempt, phase: "accepted" as const, terminalStatus: "accepted" as const, workspaceDigest, verification: { allPassed: true, validatedResultDigest: validatedDigest, verifiedAt: new Date().toISOString() } };
	const attemptDigest = await writeV3AttemptEvidence(dir, "a", 1, withLinks);
	const acceptance = {
		schemaVersion: 1 as const,
		runInstanceId: "r1",
		graphId: "g1",
		taskId: "a",
		attempt: 1,
		acceptance: "wrote out.txt",
		method: "machine-verified" as const,
		verified: true,
		validatedResultDigest: validatedDigest,
		attemptDigest,
		recordedAt: new Date().toISOString(),
		supervisorEpoch: "epoch",
	};
	await writeV3AcceptanceEvidence(dir, "a", 1, acceptance);
	assert.ok(await readV3WorkspaceEvidence(dir, "a", 1));
	assert.ok(await readV3ValidatedResult(dir, "a", 1));
	assert.ok(await readV3AcceptanceEvidence(dir, "a", 1));
	const latest = await readLatestV3Attempt(dir, "a");
	assert.equal(latest!.evidence.phase, "accepted");
	assert.equal(latest!.evidence.terminalStatus, "accepted");
	assert.equal(latest!.evidence.workspaceDigest, workspaceDigest);
	assert.equal(latest!.evidence.verification!.validatedResultDigest, validatedDigest);
});

function graph(over: Partial<CompiledGraphV3> = {}): CompiledGraphV3 {
	return {
		schemaVersion: 3,
		graphId: "g1",
		goal: "g",
		nodes: [
			{ taskId: "a", agent: "x", task: "a", dependsOn: [], inputArtifacts: [], outputArtifact: "g/a/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "b", agent: "x", task: "b", dependsOn: ["a"], inputArtifacts: [], outputArtifact: "g/b/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "c", agent: "x", task: "c", dependsOn: [], inputArtifacts: [], outputArtifact: "g/c/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
		],
		topologicalOrder: ["a", "b", "c"],
		maxConcurrency: 2,
		failFast: false,
		workspace: "auto",
		sourceGraphSpec: { schemaVersion: 3, goal: "g", nodes: [] },
		sourceGraphSpecDigest: "0".repeat(64),
		graphDigest: "1".repeat(64),
		...over,
	};
}

test("V3 scheduler returns only dependency-satisfied unstarted nodes", () => {
	const g = graph();
	const view = { phaseOf: (taskId: string) => (taskId === "a" ? "accepted" as const : undefined) };
	const ready = v3ReadyNodes(g, view);
	assert.deepEqual(ready.map((n) => n.taskId).sort(), ["b", "c"]);
	const pending = v3PendingNodes(g, view);
	assert.equal(pending.length, 2);
	assert.equal(v3GraphBlocked(g, view), false);
});

test("V3 scheduler reports a blocked graph when non-terminal nodes wait on non-accepted deps", () => {
	const g = graph({
		nodes: [
			{ taskId: "a", agent: "x", task: "a", dependsOn: [], inputArtifacts: [], outputArtifact: "g/a/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "b", agent: "x", task: "b", dependsOn: ["a"], inputArtifacts: [], outputArtifact: "g/b/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "c", agent: "x", task: "c", dependsOn: ["b"], inputArtifacts: [], outputArtifact: "g/c/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
		],
		topologicalOrder: ["a", "b", "c"],
	});
	const view = { phaseOf: (taskId: string) => (taskId === "a" ? "running" as const : undefined) };
	assert.equal(v3GraphBlocked(g, view), true);
	const ready = v3ReadyNodes(g, view);
	assert.equal(ready.length, 0);
});

test("V3 scheduler never returns started or terminal nodes", () => {
	const g = graph({
		nodes: [
			{ taskId: "a", agent: "x", task: "a", dependsOn: [], inputArtifacts: [], outputArtifact: "g/a/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "b", agent: "x", task: "b", dependsOn: [], inputArtifacts: [], outputArtifact: "g/b/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
			{ taskId: "c", agent: "x", task: "c", dependsOn: [], inputArtifacts: [], outputArtifact: "g/c/out", readScope: [], writeScope: [], sideEffect: "local_read", retryPolicy: { maxAttempts: 1, retryOn: [], backoffMs: 0 }, validationCommands: [] },
		],
		topologicalOrder: ["a", "b", "c"],
	});
	const view = { phaseOf: (taskId: string) => (taskId === "a" ? "running" as const : taskId === "c" ? "accepted" as const : undefined) };
	const ready = v3ReadyNodes(g, view);
	assert.deepEqual(ready.map((n) => n.taskId), ["b"]);
});
