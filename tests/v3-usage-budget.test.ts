import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { readLatestV3Attempt, validateV3Attempt, writeV3AttemptEvidence } from "../src/v3/attempt.ts";
import { compileGraphSpecV3 } from "../src/v3/compiler.ts";
import { canonicalDigest } from "../src/v3/digests.ts";
import { v3DispatchRequestDigest, v3GraphGuardExtensionBindings } from "../src/v3/dispatch.ts";
import { GraphMailbox } from "../src/v3/mailbox.ts";
import { MailboxBroker } from "../src/v3/mailbox-transport.ts";
import { MAILBOX_BINDING_NAMESPACE } from "../src/v3/mailbox-bindings.ts";
import { initializeV3Run } from "../src/v3/initialize.ts";
import { SubagentRpcClient } from "../src/v3/rpc.ts";
import { V3GraphRunner } from "../src/v3/runner.ts";
import type {
	GraphSpecV3,
	V3AttemptEvidence,
	V3NodeLaunchHints,
	V3UsageBudgetHint,
} from "../src/v3/types.ts";
import { evaluateV3UsageBudget, readV3UsageBudgetDecision } from "../src/v3/usage-budget.ts";
import { prepareV3Workspace } from "../src/v3/workspace.ts";
import { publishMockTerminal, MockSubagents, completeChild } from "./helpers/mock-subagents.ts";

const NOW = "2026-08-25T00:00:00.000Z";

function attempt(
	attemptNumber: number,
	options: { dispatched?: boolean; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; costUsd?: number } } = {},
): V3AttemptEvidence {
	const observation = options.usage ? { asyncId: `child-${attemptNumber}`, usage: options.usage, observedAt: NOW } : undefined;
	return {
		schemaVersion: 1,
		runInstanceId: "run-budget",
		graphId: "graph-budget",
		taskId: "work",
		attempt: attemptNumber,
		attemptNonce: `attempt-${attemptNumber}`,
		phase: "failed",
		terminalStatus: "failed",
		createdAt: NOW,
		updatedAt: NOW,
		supervisorEpoch: "epoch-budget",
		...(options.dispatched ? {
			dispatch: {
				asyncId: `child-${attemptNumber}`,
				asyncDir: `/tmp/child-${attemptNumber}`,
				requestDigest: "a".repeat(64),
				dispatchedAt: NOW,
			},
		} : {}),
		...(observation ? { observation } : {}),
		failure: { kind: "task_failed", message: "failed", at: NOW },
	};
}

test("usage budget subtracts token/cost usage across Attempts and preserves only residual soft limits", () => {
	const decision = evaluateV3UsageBudget({
		tokens: { soft: 500, hard: 1_000 },
		costUsd: { soft: 1, hard: 2 },
	}, [
		attempt(1, { dispatched: true, usage: { totalTokens: 400, costUsd: 0.25 } }),
		attempt(2, { dispatched: true, usage: { inputTokens: 70, outputTokens: 80, costUsd: 0.5 } }),
	]);
	assert.deepEqual(decision.used, { tokens: 550, costUsd: 0.75 });
	assert.deepEqual(decision.remaining, {
		tokens: { hard: 450 },
		costUsd: { soft: 0.25, hard: 1.25 },
	});
	assert.equal(decision.blocked, undefined);
});

test("usage budget blocks at the hard boundary and fails closed on missing dispatched usage", () => {
	const exhausted = evaluateV3UsageBudget({ tokens: { hard: 1_000 } }, [
		attempt(1, { dispatched: true, usage: { totalTokens: 1_000 } }),
	]);
	assert.equal(exhausted.blocked?.reason, "tokens");
	assert.equal(exhausted.remaining, undefined);

	const missing = evaluateV3UsageBudget({ tokens: { hard: 1_000 }, costUsd: { hard: 1 } }, [
		attempt(1, { dispatched: true, usage: { totalTokens: 10 } }),
	]);
	assert.equal(missing.blocked?.reason, "missing_evidence");
	assert.match(missing.blocked?.message ?? "", /costUsd/u);
	const emitting = attempt(2);
	emitting.dispatchIntent = {
		requestId: "emitting-request",
		requestDigest: "b".repeat(64),
		state: "emitting",
		preparedAt: NOW,
		emittedAt: NOW,
	};
	const emittingMissing = evaluateV3UsageBudget({ tokens: { hard: 1_000 } }, [emitting]);
	assert.equal(emittingMissing.blocked?.reason, "missing_evidence");
	assert.match(emittingMissing.blocked?.message ?? "", /Attempt 2/u);

	const neverDispatched = evaluateV3UsageBudget({ tokens: { hard: 1_000 } }, [attempt(1)]);
	assert.deepEqual(neverDispatched.remaining, { tokens: { hard: 1_000 } });
	const budgetFailure = attempt(3);
	budgetFailure.failure = { kind: "usage_budget", message: "exhausted", at: NOW };
	assert.equal(validateV3Attempt(budgetFailure).failure?.kind, "usage_budget");
});

function launchHints(usageBudget: V3UsageBudgetHint): V3NodeLaunchHints {
	const base = { schemaVersion: 1 as const, usageBudget };
	return { ...base, hintDigest: canonicalDigest(base) };
}

async function fixture(prefix = "v3-usage-budget-") {
	const sandbox = await realpath(await mkdtemp(join(tmpdir(), prefix)));
	const sourceDir = join(sandbox, "source");
	const runsDir = join(sandbox, "runs");
	await mkdir(sourceDir, { recursive: true });
	await mkdir(runsDir, { recursive: true });
	const runInstanceId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return { sandbox, sourceDir, runsDir, runDir: join(runsDir, "graph", runInstanceId), runInstanceId };
}

async function writeTerminalStatusWithUsage(input: {
	asyncDir: string;
	asyncId: string;
	state: "failed" | "complete";
	totalTokens: number;
	output?: string;
}): Promise<void> {
	const statusPath = join(input.asyncDir, "status.json");
	const previous = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
	const outputFile = join(input.asyncDir, "output.txt");
	if (input.state === "complete") await writeFile(outputFile, input.output ?? "done", "utf8");
	const { outputFile: _runningOutputFile, ...baseStatus } = previous;
	await writeFile(statusPath, JSON.stringify({
		...baseStatus,
		runId: input.asyncId,
		state: input.state,
		totalTokens: { total: input.totalTokens },
		...(input.state === "complete" ? { outputFile } : { error: "budgeted failure" }),
	}), "utf8");
}

function budgetSpec(task: string, hard = 1_000): GraphSpecV3 {
	return {
		schemaVersion: 3,
		goal: "budgeted retry",
		nodes: [{
			taskId: "work",
			agent: "test-agent",
			task,
			sideEffect: "local_read",
			retryPolicy: { maxAttempts: 2, retryOn: ["task_failed"], backoffMs: 1 },
			launch: launchHints({ tokens: { hard } }),
		}],
	};
}

test("runner preserves known usage without automatically repeating a native crash", async () => {
	const f = await fixture();
	const mock = new MockSubagents();
	let runs = 0;
	mock.behaviors.set("RESIDUAL_RETRY", async (input) => {
		runs += 1;
		await writeTerminalStatusWithUsage({
			...input,
			state: runs === 1 ? "failed" : "complete",
			totalTokens: runs === 1 ? 400 : 100,
		});
		if (runs === 1) await publishMockTerminal(input, true);
	});
	mock.start();
	const graph = compileGraphSpecV3(budgetSpec("RESIDUAL_RETRY"));
	const initialized = await initializeV3Run({
		trustedRoot: resolve(f.runsDir), runDir: f.runDir, graph,
		sessionId: "session", supervisorEpoch: "epoch-1", sourceCwd: f.sourceDir, runInstanceId: f.runInstanceId,
	}, { processIdentityForPid: async () => "test-process" });
	const runner = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: f.runDir, graph, authorization: initialized.authorization,
		sourceCwd: f.sourceDir, sessionId: "session", supervisorEpoch: "epoch-1", preflightAgent: async () => undefined,
	});
	const snapshot = await runner.run();
	assert.equal(snapshot.status, "needs_attention", JSON.stringify((await readLatestV3Attempt(f.runDir, "work"))?.evidence));
	assert.equal(mock.spawned.length, 1);
	assert.deepEqual(mock.spawned[0]?.params.usageBudget, { tokens: { hard: 1_000 } });
	assert.equal((await readLatestV3Attempt(f.runDir, "work"))?.evidence.child?.observation?.usage?.totalTokens, 400);
	assert.equal((await readLatestV3Attempt(f.runDir, "work"))?.attempt, 1);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});

test("native crash keeps budget evidence and cannot bypass the next-attempt budget gate", async () => {
	const f = await fixture();
	const mock = new MockSubagents();
	mock.behaviors.set("EXHAUST_RETRY", async (input) => { await writeTerminalStatusWithUsage({ ...input, state: "failed", totalTokens: 1_000 }); await publishMockTerminal(input,true); });
	mock.start();
	const graph = compileGraphSpecV3(budgetSpec("EXHAUST_RETRY"));
	const initialized = await initializeV3Run({
		trustedRoot: resolve(f.runsDir), runDir: f.runDir, graph,
		sessionId: "session", supervisorEpoch: "epoch-1", sourceCwd: f.sourceDir, runInstanceId: f.runInstanceId,
	}, { processIdentityForPid: async () => "test-process" });
	const runner = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: f.runDir, graph, authorization: initialized.authorization,
		sourceCwd: f.sourceDir, sessionId: "session", supervisorEpoch: "epoch-1", preflightAgent: async () => undefined,
	});
	const snapshot = await runner.run();
	assert.equal(snapshot.status, "needs_attention", JSON.stringify((await readLatestV3Attempt(f.runDir, "work"))?.evidence));
	assert.equal(mock.spawned.length, 1);
	const latest = (await readLatestV3Attempt(f.runDir, "work"))!;
	assert.equal(latest.attempt, 1, "budget exhaustion must not invent an automatic retry Attempt");
	assert.equal(latest.evidence.failure?.kind, "task_failed");
	assert.equal(latest.evidence.child?.observation?.usage?.totalTokens, 1000);
	assert.ok((await readV3UsageBudgetDecision(f.runDir, "work", 2, { tokens: { hard: 1000 } })).blocked);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});

test("resume suppresses an old automatic retry, while explicit retry records a no-dispatch budget failure Attempt", async () => {
	const f = await fixture("v3-usage-resume-");
	const mock = new MockSubagents();
	mock.start();
	const graph = compileGraphSpecV3(budgetSpec("MUST_NOT_DISPATCH"));
	const initialized = await initializeV3Run({
		trustedRoot: resolve(f.runsDir), runDir: f.runDir, graph,
		sessionId: "session", supervisorEpoch: "epoch-1", sourceCwd: f.sourceDir, runInstanceId: f.runInstanceId,
	}, { processIdentityForPid: async () => "test-process" });
	await writeV3AttemptEvidence(f.runDir, "work", 1, {
		...attempt(1, { dispatched: true, usage: { totalTokens: 1_000 } }),
		runInstanceId: f.runInstanceId,
		graphId: graph.graphId,
		supervisorEpoch: "epoch-1",
	});
	const automatic = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: f.runDir, graph, authorization: initialized.authorization,
		sourceCwd: f.sourceDir, sessionId: "session", supervisorEpoch: "epoch-2", preflightAgent: async () => undefined,
	});
	await automatic.initializeForResume();
	assert.equal((await automatic.run()).status, "failed");
	assert.equal((await readLatestV3Attempt(f.runDir, "work"))?.attempt, 1);
	assert.equal(mock.spawned.length, 0);

	const explicit = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: f.runDir, graph, authorization: initialized.authorization,
		sourceCwd: f.sourceDir, sessionId: "session", supervisorEpoch: "epoch-3", retryBaselines: { work: 1 },
		preflightAgent: async () => undefined,
	});
	await explicit.initializeForResume();
	assert.equal((await explicit.run()).status, "needs_attention");
	const latest = (await readLatestV3Attempt(f.runDir, "work"))!;
	assert.equal(latest.attempt, 1, "unconfirmed old process cannot be retried, even explicitly");
	assert.equal(mock.spawned.length, 0);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});

test("prepared recovery reconstructs the original dispatch digest with the same residual budget", async () => {
	const f = await fixture("v3-usage-recovery-");
	const mock = new MockSubagents();
	mock.behaviors.set("RECOVER_RESIDUAL", (input) => completeChild({ ...input, output: "recovered" }));
	mock.start();
	const graph = compileGraphSpecV3(budgetSpec("RECOVER_RESIDUAL"));
	const initialized = await initializeV3Run({
		trustedRoot: resolve(f.runsDir), runDir: f.runDir, graph,
		sessionId: "session", supervisorEpoch: "epoch-1", sourceCwd: f.sourceDir, runInstanceId: f.runInstanceId,
	}, { processIdentityForPid: async () => "test-process" });
	const first = attempt(1, { dispatched: true, usage: { totalTokens: 400 } });
	await writeV3AttemptEvidence(f.runDir, "work", 1, {
		...first,
		runInstanceId: f.runInstanceId,
		graphId: graph.graphId,
		supervisorEpoch: "epoch-1",
		child: {
			terminal: "failed",
			output: "failed",
			completedAt: NOW,
			observation: { asyncId: "child-1", usage: { totalTokens: 400 }, observedAt: NOW },
		},
	});
	const node = graph.nodes[0]!;
	const workspace = await prepareV3Workspace({
		runInstanceId: f.runInstanceId, graphId: graph.graphId, node, attempt: 2,
		runDir: f.runDir, sourceCwd: f.sourceDir, workspace: graph.workspace,
	});
	const mailbox = new GraphMailbox(f.runDir, { withFence: async (work) => work() }, async () => true);
	await mailbox.initialize(f.runInstanceId, "session", [{taskId:"work",attempt:2}]);
	const broker = new MailboxBroker(mailbox);
	await broker.start();
	const mailboxBinding = {socketPath:broker.socketPath,token:await mailbox.capability("work",2)};
	await broker.close();
	const recoveredSpec = {
		agent: node.agent,
		requestedAgent: node.agent,
		task: node.task,
		cwd: workspace.workspaceCwd,
		sessionDir: join(f.runDir, "sessions", "work"),
		agentScope: "project" as const,
		usageBudget: { tokens: { hard: 600 } },
		extensionBindings: {...v3GraphGuardExtensionBindings(workspace.evidence),[MAILBOX_BINDING_NAMESPACE]:mailboxBinding},
		graphToolFilter: [],
	};
	await writeV3AttemptEvidence(f.runDir, "work", 2, {
		schemaVersion: 1,
		runInstanceId: f.runInstanceId,
		graphId: graph.graphId,
		taskId: "work",
		attempt: 2,
		attemptNonce: "attempt-2",
		phase: "prepared",
		createdAt: NOW,
		updatedAt: NOW,
		supervisorEpoch: "epoch-1",
		workspaceDigest: canonicalDigest(workspace.evidence),
		dispatchIntent: {
			requestId: "recover-residual-request",
			requestDigest: v3DispatchRequestDigest(recoveredSpec),
			state: "prepared",
			preparedAt: NOW,
		},
	});
	const resumed = new V3GraphRunner({
		rpc: new SubagentRpcClient(mock), runDir: f.runDir, graph, authorization: initialized.authorization,
		sourceCwd: f.sourceDir, sessionId: "session", supervisorEpoch: "epoch-2", preflightAgent: async () => undefined,
	});
	await resumed.initializeForResume();
	assert.equal((await resumed.run()).status, "complete");
	assert.deepEqual(mock.spawned[0]?.params.usageBudget, { tokens: { hard: 600 } });
	assert.deepEqual(mock.spawned[0]?.params.extensionBindings, recoveredSpec.extensionBindings);
	assert.equal((await readLatestV3Attempt(f.runDir, "work"))?.attempt, 2);
	await mock.dispose();
	await import("node:fs/promises").then((fs) => fs.rm(f.sandbox, { recursive: true, force: true }));
});
