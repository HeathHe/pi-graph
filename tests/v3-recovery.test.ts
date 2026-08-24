import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import {
	readLatestV3Attempt,
	v3AcceptedAttemptBasis,
	writeV3AcceptanceEvidence,
	writeV3AttemptEvidence,
	writeV3ValidatedResult,
	writeV3WorkspaceEvidence,
} from "../src/v3/attempt.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { v3DispatchChild } from "../src/v3/dispatch.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { resumeV3GraphRun } from "../src/v3/runner.ts";
import { prepareV3Workspace } from "../src/v3/workspace.ts";
import type { CompiledGraphNodeV3, GraphSpecV3 } from "../src/v3/types.ts";
import { MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

async function fixture() {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), "v3-recovery-")));
	const sourceCwd = join(sandbox, "source");
	await mkdir(sourceCwd, { recursive: true });
	const runsDir = join(sandbox, "runs");
	await mkdir(runsDir, { recursive: true });
	const runInstanceId = "rec-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
	const runDir = join(runsDir, "g", runInstanceId);
	return { sandbox, sourceCwd, runsDir, runDir, runInstanceId };
}

function specTwoNode(): GraphSpecV3 {
	return {
		schemaVersion: 3,
		goal: "recovery",
		maxConcurrency: 2,
		nodes: [
			{ taskId: "a", agent: "test-agent", task: "REC_A write out-a.txt", sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-a.txt" }], validationCommands: ["test -f out-a.txt"] },
			{ taskId: "b", agent: "test-agent", task: "REC_B write out-b.txt", dependsOn: ["a"], sideEffect: "local_write", writeScope: [{ kind: "file", path: "out-b.txt" }], validationCommands: ["test -f out-b.txt"] },
		],
	};
}

function nodeOf(graphNodes: CompiledGraphNodeV3[], taskId: string): CompiledGraphNodeV3 {
	return graphNodes.find((node) => node.taskId === taskId)!;
}

test("V3 resume monitors an already-dispatched child instead of re-dispatching and never re-applies accepted nodes", async () => {
	const f = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("REC_B", (input) => completeChild({ ...input, writes: [{ path: "out-b.txt", content: "b\n" }] }));
	mock.start();
	const spec = specTwoNode();
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: f.runsDir, runDir: f.runDir, graph, sessionId: "session", supervisorEpoch: "epoch", sourceCwd: f.sourceCwd, runInstanceId: f.runInstanceId });
	const now = new Date().toISOString();

	// Node A was already accepted before the crash: fabricate its full evidence chain.
	const nodeA = nodeOf(graph.nodes, "a");
	const aWorkspace = await prepareV3Workspace({ runInstanceId: f.runInstanceId, graphId: graph.graphId, node: nodeA, attempt: 1, runDir: f.runDir, sourceCwd: f.sourceCwd, workspace: "shadow" });
	const aWrites = [{ path: join(f.sourceCwd, "out-a.txt"), before: undefined, after: createHash("sha256").update("a\n").digest("hex") }];
	const aValidated: import("../src/v3/types.ts").V3ValidatedResult = {
		schemaVersion: 1, runInstanceId: f.runInstanceId, graphId: graph.graphId, taskId: "a", attempt: 1,
		validations: [{ command: "test -f out-a.txt", ok: true, exitCode: 0, signal: null, timedOut: false, stdout: "", stdoutTruncated: false, stderr: "", stderrTruncated: false, durationMs: 1 }],
		allPassed: true, writes: aWrites, recordedAt: now,
	};
	const aValidatedDigest = await writeV3ValidatedResult(f.runDir, "a", 1, aValidated);
	const aAttempt: Parameters<typeof writeV3AttemptEvidence>[3] = {
		schemaVersion: 1, runInstanceId: f.runInstanceId, graphId: graph.graphId, taskId: "a", attempt: 1, attemptNonce: "a-1",
		phase: "accepted", terminalStatus: "accepted", createdAt: now, updatedAt: now, supervisorEpoch: "epoch",
		workspaceDigest: (await import("../src/v3/digests.ts")).canonicalDigest(aWorkspace.evidence),
		verification: { allPassed: true, validatedResultDigest: aValidatedDigest, verifiedAt: now },
		applied: { writes: aWrites, appliedAt: now },
		child: { terminal: "complete", output: "a-done", completedAt: now },
	};
	await mkdir(join(f.runDir, "artifacts", "a"), { recursive: true });
	await writeFile(join(f.runDir, "artifacts", "a", "attempt-1.txt"), JSON.stringify({ taskId: "a", output: "a-done" }), "utf8");
	const aAcceptanceDigest = await writeV3AcceptanceEvidence(f.runDir, "a", 1, {
		schemaVersion: 1,
		runInstanceId: f.runInstanceId,
		graphId: graph.graphId,
		taskId: "a",
		attempt: 1,
		method: "machine-verified",
		verified: true,
		validatedResultDigest: aValidatedDigest,
		attemptDigest: canonicalDigest(v3AcceptedAttemptBasis(aAttempt)),
		recordedAt: now,
		supervisorEpoch: "epoch",
	});
	await writeV3AttemptEvidence(f.runDir, "a", 1, { ...aAttempt, acceptanceDigest: aAcceptanceDigest });
	await writeFile(join(f.sourceCwd, "out-a.txt"), "a\n", "utf8");

	// Node B was mid-flight (dispatched, child running) when the process crashed.
	const nodeB = nodeOf(graph.nodes, "b");
	const bWorkspace = await prepareV3Workspace({ runInstanceId: f.runInstanceId, graphId: graph.graphId, node: nodeB, attempt: 1, runDir: f.runDir, sourceCwd: f.sourceCwd, workspace: "shadow" });
	const binding = await v3DispatchChild(rpc, { agent: "test-agent", task: "REC_B write out-b.txt", cwd: bWorkspace.workspaceCwd, sessionDir: join(f.runDir, "sessions", "b") });
	const bAttempt: Parameters<typeof writeV3AttemptEvidence>[3] = {
		schemaVersion: 1, runInstanceId: f.runInstanceId, graphId: graph.graphId, taskId: "b", attempt: 1, attemptNonce: "b-1",
		phase: "running", createdAt: now, updatedAt: now, supervisorEpoch: "epoch",
		dispatch: binding,
		workspaceDigest: (await import("../src/v3/digests.ts")).canonicalDigest(bWorkspace.evidence),
	};
	await writeV3AttemptEvidence(f.runDir, "b", 1, bAttempt);

	// Resume: B must be monitored via its existing child (no re-dispatch), then verified and applied.
	const snapshot = await resumeV3GraphRun({
		rpc,
		runDir: f.runDir,
		graph,
		authorization: init.authorization,
		sourceCwd: f.sourceCwd,
		sessionId: "session",
		supervisorEpoch: "epoch",
		preflightAgent: async () => undefined,
	});
	assert.equal(snapshot.status, "complete");
	// B dispatched exactly once (the pre-crash dispatch), never re-dispatched.
	const bDispatches = mock.spawned.filter((entry) => String(entry.params.task).includes("REC_B"));
	assert.equal(bDispatches.length, 1);
	// A was never dispatched (already accepted).
	const aDispatches = mock.spawned.filter((entry) => String(entry.params.task).includes("REC_A"));
	assert.equal(aDispatches.length, 0);
	// B's write was applied to source exactly once.
	assert.equal(await readFile(join(f.sourceCwd, "out-b.txt"), "utf8"), "b\n");
	const bLatest = await readLatestV3Attempt(f.runDir, "b");
	assert.equal(bLatest!.evidence.phase, "accepted");
	assert.equal(bLatest!.evidence.attempt, 1, "no duplicate attempt was created");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});

test("V3 resume refuses to blindly re-dispatch a prepared attempt without a dispatch binding", async () => {
	const f = await fixture();
	const mock = new MockSubagents();
	mock.start();
	const spec = specTwoNode();
	const graph = compileGraphSpecV3(spec);
	const rpc = new SubagentRpcClient(mock);
	const init = await initializeV3Run({ trustedRoot: f.runsDir, runDir: f.runDir, graph, sessionId: "session", supervisorEpoch: "epoch", sourceCwd: f.sourceCwd, runInstanceId: f.runInstanceId });
	const now = new Date().toISOString();
	// Node A prepared but never dispatched.
	await writeV3AttemptEvidence(f.runDir, "a", 1, {
		schemaVersion: 1, runInstanceId: f.runInstanceId, graphId: graph.graphId, taskId: "a", attempt: 1, attemptNonce: "a-1",
		phase: "prepared", createdAt: now, updatedAt: now, supervisorEpoch: "epoch",
	});
	const snapshot = await resumeV3GraphRun({
		rpc, runDir: f.runDir, graph, authorization: init.authorization, sourceCwd: f.sourceCwd,
		sessionId: "session", supervisorEpoch: "epoch", preflightAgent: async () => undefined,
	});
	assert.equal(snapshot.status, "needs_attention");
	const latest = await readLatestV3Attempt(f.runDir, "a");
	assert.equal(latest!.evidence.phase, "needs_attention");
	assert.equal(latest!.evidence.failure!.kind, "dispatch_unknown");
	assert.equal(mock.spawned.length, 0, "no child was dispatched");
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});
