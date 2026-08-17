import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compileGraph } from "../src/compile.ts";
import { assertRedispatchAllowed, assertRoutingReevaluationPreDispatch, GraphManager, legacySessionIdentity, loadValidatedGraph, sessionIdentity, waitingInputResumeAction } from "../src/manager.ts";
import { evaluateRoutingPolicy } from "../src/model-routing/evaluate-routing-policy.ts";
import type { ModelRoutingConfig, RoutingDecision } from "../src/model-routing/types.ts";
import { graphRoutingTaskBinding } from "../src/model-routing-adapter.ts";
import { LeaseRegistry } from "../src/leases.ts";
import { subagentAsyncRoot, type EventBus } from "../src/rpc.ts";
import { GraphRunner, initialSnapshot } from "../src/runner.ts";
import { GraphStore } from "../src/store.ts";
import type { GraphConfig, GraphSpec } from "../src/types.ts";
import { loadValidatedRun } from "../src/reconciler.ts";
import { auditManagedLaunchContracts } from "../src/pi-subagents-preflight.ts";
import { canonicalDigest, isRoutingDriftResumeTerminal, ROUTING_DRIFT_RESUME_TERMINAL_ERROR, type AttemptRecord } from "../src/authorization.ts";
import { prepareWorkspace } from "../src/workspace.ts";
import { childAcceptanceFor, taskPrompt } from "../src/executor.ts";

const graphGuardAcknowledgement = { version: 1, source: "child-runtime", ids: ["pi-graph-guard"], omitted: 0 } as const;

function parseGraphChildParams(params: Record<string, unknown>): Record<string, unknown> {
	const workflowScript = params.workflowScript;
	if (workflowScript === undefined) return params;
	if (typeof workflowScript !== "string") throw new Error("Expected a string Graph workflowScript.");
	const match = /^return await runs\.run\(("(?:[^"\\]|\\.)*"), (\{.*\})\);$/u.exec(workflowScript);
	if (!match) throw new Error("Unexpected Graph child workflowScript.");
	return JSON.parse(match[2]!) as Record<string, unknown>;
}

class ControllableBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	started = false;
	private asyncDir?: string;
	private asyncId?: string;
	on(channel: string, handler: (data: unknown) => void) { const set = this.handlers.get(channel) ?? new Set(); set.add(handler); this.handlers.set(channel, set); return () => set.delete(handler); }
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "spawn") {
			const innerParams = parseGraphChildParams(request.params);
			const suffix = request.requestId.slice(-24);
			const usesOuterWorkflow = typeof request.params.workflowScript === "string";
			const outerAsyncId = `pi-graph-manager-control-outer-${suffix}`;
			const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
			this.asyncId = `pi-graph-manager-control-inner-${suffix}`;
			this.asyncDir = join(subagentAsyncRoot(), this.asyncId);
			void (async () => {
				if (usesOuterWorkflow) await mkdir(outerAsyncDir, { recursive: true });
				await mkdir(this.asyncDir!, { recursive: true });
				await writeFile(join(this.asyncDir!, "status.json"), JSON.stringify({ runId: this.asyncId, state: "running", sessionId: "session", sessionDir: usesOuterWorkflow ? join(innerParams.sessionDir as string, "child") : innerParams.sessionDir }));
				if (usesOuterWorkflow) await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "complete", sessionId: "session", sessionDir: request.params.sessionDir, workflow: { value: { runId: this.asyncId, artifactPaths: [this.asyncDir] } } }));
				this.started = true;
				this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { details: { asyncId: usesOuterWorkflow ? outerAsyncId : this.asyncId, asyncDir: usesOuterWorkflow ? outerAsyncDir : this.asyncDir } } });
			})();
		}
		if (request.method === "stop") {
			void (async () => {
				const target = request.params.id ?? request.params.statusFile;
				const targetsInner = target === undefined || target === this.asyncId || target === this.asyncDir || (this.asyncDir !== undefined && target === join(this.asyncDir, "status.json"));
				const asyncId = targetsInner && this.asyncId ? this.asyncId : String(request.params.id ?? this.asyncId);
				const asyncDir = targetsInner && this.asyncDir ? this.asyncDir : join(subagentAsyncRoot(), asyncId);
				await mkdir(asyncDir, { recursive: true });
				let status: Record<string, unknown> = {};
				try { status = JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")) as Record<string, unknown>; } catch { /* create a terminal status below */ }
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ ...status, runId: asyncId, state: "stopped", sessionId: status.sessionId ?? "session" }));
				this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { state: "stopping" } });
			})();
		}
	}
}

class CompletingBus implements EventBus {
	private handlers = new Map<string, Set<(data: unknown) => void>>();
	spawns = 0;
	stopCalls = 0;
	asyncDirs: string[] = [];
	models: string[] = [];
	spawnParams: Record<string, unknown>[] = [];
	innerParams: Record<string, unknown>[] = [];
	private readonly availableModels: Array<{ provider: string; id: string; reasoning: boolean; input?: Array<"text" | "image"> }>;
	constructor(availableModels: Array<{ provider: string; id: string; reasoning: boolean; input?: Array<"text" | "image"> }> = [{ provider: "openai", id: "gpt-pro", reasoning: true }]) { this.availableModels = availableModels; }
	on(channel: string, handler: (data: unknown) => void) {
		const set = this.handlers.get(channel) ?? new Set();
		set.add(handler);
		this.handlers.set(channel, set);
		return () => set.delete(handler);
	}
	emit(channel: string, data: unknown) {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
		if (channel !== "subagents:rpc:v1:request") return;
		const request = data as { requestId: string; method: string; params: Record<string, unknown> };
		if (request.method === "stop") {
			this.stopCalls += 1;
			return;
		}
		if (request.method !== "spawn") return;
		const innerParams = parseGraphChildParams(request.params);
		this.spawns += 1;
		this.models.push(String(innerParams.model ?? ""));
		this.spawnParams.push(structuredClone(request.params));
		this.innerParams.push(innerParams);
		const suffix = request.requestId.slice(-24);
		const usesOuterWorkflow = typeof request.params.workflowScript === "string";
		const outerAsyncId = `manager-outer-${suffix}`;
		const outerAsyncDir = join(subagentAsyncRoot(), outerAsyncId);
		const innerAsyncId = `manager-complete-${suffix}`;
		const innerAsyncDir = join(subagentAsyncRoot(), innerAsyncId);
		this.asyncDirs.push(...(usesOuterWorkflow ? [outerAsyncDir, innerAsyncDir] : [innerAsyncDir]));
		void (async () => {
			if (usesOuterWorkflow) await mkdir(outerAsyncDir, { recursive: true });
			await mkdir(innerAsyncDir, { recursive: true });
			const launchAudit = await auditManagedLaunchContracts({
				tasks: [innerParams],
				cwd: innerParams.cwd as string,
				availableModels: this.availableModels,
				requireExtensionSeal: true,
				graphWorkspaceKind: "shadow",
			});
			const modelEvidence = { steps: [{
				...(typeof innerParams.model === "string" ? { model: innerParams.model, attemptedModels: [innerParams.model] } : {}),
				launchContractDigest: launchAudit.contracts[0]?.launchContractDigest,
				runtimeAcknowledgedExtensions: graphGuardAcknowledgement,
			}] };
			const innerStatus = { runId: innerAsyncId, state: "running", sessionId: "session-id", sessionDir: usesOuterWorkflow ? join(innerParams.sessionDir as string, "child") : innerParams.sessionDir, ...modelEvidence };
			await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify(innerStatus));
			if (usesOuterWorkflow) await writeFile(join(outerAsyncDir, "status.json"), JSON.stringify({ runId: outerAsyncId, state: "complete", sessionId: "session-id", sessionDir: request.params.sessionDir, workflow: { value: { runId: innerAsyncId, artifactPaths: [innerAsyncDir] } } }));
			this.emit(`subagents:rpc:v1:reply:${request.requestId}`, { version: 1, requestId: request.requestId, success: true, data: { details: { asyncId: usesOuterWorkflow ? outerAsyncId : innerAsyncId, asyncDir: usesOuterWorkflow ? outerAsyncDir : innerAsyncDir } } });
			await mkdir(join(innerParams.output as string, ".."), { recursive: true });
			await writeFile(innerParams.output as string, "accepted output");
			const outputLog = join(innerAsyncDir, "output.log");
			await writeFile(outputLog, "accepted output");
			await writeFile(join(innerAsyncDir, "status.json"), JSON.stringify({ ...innerStatus, state: "complete", outputFile: outputLog }));
			this.emit("subagent:async-complete", { runId: innerAsyncId, asyncDir: innerAsyncDir });
		})();
	}
}

function managerFor(
	bus: EventBus,
	config: GraphConfig,
	cwd: string,
	availableModels: Array<{ provider: string; id: string; reasoning: boolean; input?: Array<"text" | "image"> }> | (() => Array<{ provider: string; id: string; reasoning: boolean; input?: Array<"text" | "image"> }>) = [{ provider: "openai", id: "gpt-pro", reasoning: true }],
): GraphManager {
	const manager = new GraphManager({ events: bus, sendMessage() {}, } as any);
	Object.assign(manager as any, {
		allowUnplannedStartForTests: true,
		config,
		context: {
			cwd,
			modelRegistry: { getAvailable: () => typeof availableModels === "function" ? availableModels() : availableModels },
			sessionManager: { getSessionFile: () => "session", getSessionId: () => "session-id" },
			ui: { notify() {} },
		},
	});
	return manager;
}

async function providerResetCrashFixture(cwd: string, runs: string, graphId: string) {
	const graph = compileGraph({ schemaVersion: 1, graphId, goal: "recover provider reset", workspace: "shadow", nodes: [{
		taskId: "node",
		agent: "code-scout",
		task: "RECOVER_PROVIDER_RESET",
		outputArtifact: "node.md",
		sideEffect: "none",
		retryPolicy: { maxAttempts: 1, maxProviderRetries: 1, providerBackoffMs: 1 },
	}] } as GraphSpec, cwd, 10, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const node = graph.nodes[0]!;
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node, attempt: 1, attemptDir: attemptRoot, strategy: "shadow", protectedSourceRoots: [runs], artifacts: [] });
	const attemptNonce = randomUUID();
	const asyncId = `manager-reset-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	const now = new Date().toISOString();
	const sessionDir = join(attemptRoot, "session");
	const lineage = { runInstanceId: snapshot.runInstanceId, graphId: graph.graphId, taskId: "node", attempt: 1, attemptNonce, sessionDir, ownerSessionId: "session-id" };
	const childParams = { agent: node.agent, task: taskPrompt(graph, node, workspace, lineage), cwd: workspace.cwd, context: "fresh", async: true, sessionDir, agentScope: "both", artifacts: true, output: join(attemptRoot, "output", "node.md"), outputMode: "file-only", acceptance: childAcceptanceFor(node) };
	const guardAudit = await auditManagedLaunchContracts({ tasks: [childParams], cwd: node.cwd, requireExtensionSeal: true, graphWorkspaceKind: workspace.kind });
	const launchContractDigest = guardAudit.contracts[0]?.launchContractDigest!;
	const extensionContentDigest = guardAudit.contracts[0]?.extensionContentDigest!;
	assert.equal(guardAudit.ok, true, guardAudit.issues.join(" "));
	const observedAt = Date.now();
	const processInstanceId = `runner-${asyncId}`;
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({
		runId: asyncId,
		state: "failed",
		error: "structured provider failure",
		failureDomain: "provider",
		failureCode: "unavailable",
		failureStage: "runtime",
		retryAfterMs: 0,
		sessionDir,
		steps: [{ launchContractDigest, runtimeAcknowledgedExtensions: graphGuardAcknowledgement }],
		processTerminal: {
			version: 1,
			state: "observed",
			runId: asyncId,
			runnerProcessInstanceId: processInstanceId,
			observedAt,
			instances: [{ processInstanceId, kind: "runner", closeObservedAt: observedAt, exitCode: 1, signal: null }],
		},
	}));
	const failure = { kind: "provider_transient" as const, retryKind: "provider" as const, retryAfterMs: 0 };
	snapshot.status = "running";
	snapshot.nodes.node = {
		taskId: "node",
		status: "running",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "running",
			startedAt: now,
			sessionDir,
			workspaceDir: workspace.cwd,
			workspaceKind: "shadow",
			outputPath: join(attemptRoot, "output", "node.md"),
			providerDispatches: [{ dispatch: 1, status: "failed", sessionDir, startedAt: now, endedAt: now, asyncId, asyncDir, requestDigest: "a".repeat(64), launchContractDigest, extensionContentDigest, failure }],
		}],
	};
	await store.saveSnapshot(snapshot);
	const authority = {
		schemaVersion: 2 as const,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "node",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: snapshot.supervisorEpoch,
		fencingGeneration: snapshot.fencingGeneration,
		updatedAt: now,
	};
	await store.writeAttemptRecord("node", 1, { ...authority, phase: "prepared", launchContractDigest, extensionContentDigest });
	await store.writeWorkspaceRecord("node", 1, {
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "node",
		attempt: 1,
		workspaceKind: "shadow",
		contractDigest: canonicalDigest(workspace.contract),
		writeBaseline: workspace.contract.writeBaseline,
		readBaseline: workspace.contract.readBaseline,
		inputBaseline: workspace.contract.inputBaseline,
		createdAt: now,
	});
	await store.writeAttemptRecord("node", 1, { ...authority, phase: "dispatching", requestDigest: "a".repeat(64), asyncId });
	await store.writeAttemptRecord("node", 1, { ...authority, phase: "running", requestDigest: "a".repeat(64), asyncId });
	await store.writeJson("nodes/node/attempt-1/child-dispatch.json", {
		schemaVersion: 1,
		requestDigest: "a".repeat(64),
		phase: "bound",
		asyncId,
		lineage,
	});
	await store.writeJson("nodes/node/attempt-1/provider-workspace-reset.json", {
		schemaVersion: 1,
		graphId: graph.graphId,
		taskId: "node",
		attempt: 1,
		attemptNonce,
		nextDispatch: 2,
		phase: "prepared",
		contractDigest: canonicalDigest(workspace.contract),
		preparedAt: now,
	});
	await rm(workspace.cwd, { recursive: true, force: true });
	await mkdir(workspace.cwd, { recursive: true });
	await writeFile(join(workspace.cwd, "partial.txt"), "partial reset\n");
	return { graph, snapshot, store, asyncDir };
}

for (const mode of ["resume", "adopt"] as const) {
	test(`Manager ${mode} consumes an authorized provider reset journal before strict loading`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), `pi-graph-manager-reset-${mode}-`));
		const runs = join(cwd, "runs");
		const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 10, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
		const fixture = await providerResetCrashFixture(cwd, runs, `manager-reset-${mode}`);
		await assert.rejects(loadValidatedRun(fixture.store, 10), /node contract/i);
		await assert.doesNotReject(loadValidatedGraph(fixture.store, fixture.snapshot, 10, true));
		const bus = new CompletingBus();
		const manager = managerFor(bus, graphConfig, cwd);
		try {
			if (mode === "resume") await manager.resume(fixture.graph.graphId);
			else {
				const context = (manager as any).context;
				await (manager as any).adoptGraph(fixture.graph.graphId, fixture.store, "session-id", "session", graphConfig, context, 0);
			}
			const deadline = Date.now() + 15_000;
			let terminal = await fixture.store.loadSnapshot();
			while (["queued", "running"].includes(terminal.status) && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 25));
				terminal = await fixture.store.loadSnapshot();
			}
			assert.equal(terminal.status, "complete", JSON.stringify(terminal));
			assert.equal(terminal.nodes.node?.attempt, 1);
			assert.equal(terminal.nodes.node?.attempts[0]?.providerDispatches?.length, 2);
			assert.equal(bus.spawns, 1);
			assert.equal(Object.hasOwn(bus.spawnParams[0] ?? {}, "clarify"), false);
			await assert.doesNotReject(loadValidatedRun(fixture.store, 10));
		} finally {
			await manager.suspendAll();
			for (const asyncDir of [fixture.asyncDir, ...bus.asyncDirs]) await rm(asyncDir, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
		}
	});
}

test("provider reset recovery rejects a workspace symlink without touching its external target", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-reset-symlink-"));
	const runs = join(cwd, "runs");
	const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 10, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const fixture = await providerResetCrashFixture(cwd, runs, "manager-reset-symlink");
	const workspaceDir = fixture.store.path("nodes", "node", "attempt-1", "workspace");
	const externalWorkspace = join(cwd, "external-workspace");
	await rm(workspaceDir, { recursive: true, force: true });
	await mkdir(externalWorkspace);
	await writeFile(join(externalWorkspace, "victim.txt"), "keep\n");
	await symlink(externalWorkspace, workspaceDir);
	const bus = new CompletingBus();
	const manager = managerFor(bus, graphConfig, cwd);
	try {
		await manager.resume(fixture.graph.graphId);
		const deadline = Date.now() + 10_000;
		let terminal = await fixture.store.loadSnapshot();
		while (["queued", "running"].includes(terminal.status) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			terminal = await fixture.store.loadSnapshot();
		}
		assert.equal(terminal.status, "needs_attention");
		assert.equal(terminal.nodes.node?.status, "stale");
		assert.equal(bus.spawns, 0);
		assert.equal(await readFile(join(externalWorkspace, "victim.txt"), "utf8"), "keep\n");
	} finally {
		await manager.suspendAll();
		for (const asyncDir of [fixture.asyncDir, ...bus.asyncDirs]) await rm(asyncDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("paused children must be resumed or stopped instead of duplicated", () => {
	assert.throws(() => waitingInputResumeAction("paused", "pause"), /still paused/);
	assert.equal(waitingInputResumeAction("running"), "monitor");
	assert.equal(waitingInputResumeAction("complete"), "monitor");
	assert.throws(() => waitingInputResumeAction(undefined), /will not replace/);
	assert.throws(() => waitingInputResumeAction("stopped"), /will not replace/);
});

test("routing re-evaluation rejects any legacy attempt that already has a child identity", () => {
	const attempt = { attempt: 1, status: "waiting_input" as const, sessionDir: "/tmp/session", asyncId: "live-child", asyncDir: "/tmp/async-live" };
	assert.throws(() => assertRoutingReevaluationPreDispatch(attempt), /may already have dispatched/);
	assert.doesNotThrow(() => assertRoutingReevaluationPreDispatch({ attempt: 1, status: "waiting_input", sessionDir: "/tmp/session" }));
});

test("waiting-input resume rejects a missing child status instead of leasing a dead identity", () => {
	assert.throws(() => waitingInputResumeAction(undefined, "identity-bearing-node"), /will not replace/);
});

test("a committed routing-drift resume transition is recognizable after a snapshot-save crash", () => {
	const authority: AttemptRecord = {
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		graphId: "drift-crash",
		taskId: "node",
		attempt: 1,
		attemptNonce: randomUUID(),
		phase: "terminal",
		supervisorEpoch: randomUUID(),
		fencingGeneration: 1,
		terminalStatus: "failed",
		terminalError: ROUTING_DRIFT_RESUME_TERMINAL_ERROR,
		terminalRetryKind: "failed",
		updatedAt: new Date().toISOString(),
	};
	assert.equal(isRoutingDriftResumeTerminal(authority), true);
	assert.equal(isRoutingDriftResumeTerminal({ ...authority, requestDigest: "a".repeat(64) }), false);
	assert.equal(isRoutingDriftResumeTerminal({ ...authority, terminalError: "different transition" }), false);
});

test("manual resume re-evaluates a childless L3 route as a new attempt and new sealed decision", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-l3-resume-"));
	const runs = join(cwd, "runs");
	const agentDir = join(cwd, "agent");
	const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 4, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: false };
	const routingRegistry = {
		schemaVersion: 1 as const,
		models: [
			{ model: "openai/gpt-pro", family: "gpt", provider: "openai", providerDomain: "openai", thinkingLevels: ["high" as const] },
			{ model: "ark/glm-pro", family: "glm", provider: "ark", providerDomain: "volcengine", thinkingLevels: ["high" as const] },
		],
	};
	const oldRoutingConfig: ModelRoutingConfig = {
		registry: routingRegistry,
		policy: { schemaVersion: 1, enforcement: "require", profiles: { route: { candidates: [{ model: "openai/gpt-pro", thinking: "high", level: "L2" }] } } },
		configDigest: "1".repeat(64),
	};
	const graph = compileGraph({ schemaVersion: 1, graphId: "l3-manual-resume", goal: "resume routing", workspace: "shadow", nodes: [
		{ taskId: "node", agent: "worker", task: "work", routingProfile: "route", taskRisk: "high", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const decision = evaluateRoutingPolicy(oldRoutingConfig, {
		taskBinding: graphRoutingTaskBinding({ graphId: graph.graphId, taskId: "node", task: "work" }),
		routingProfile: "route",
		taskRisk: "high",
	});
	assert.equal(decision.fallbackLevel, "L3");
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	snapshot.status = "needs_attention";
	snapshot.nodes.node = {
		taskId: "node",
		status: "waiting_input",
		attempt: 1,
		attempts: [{ attempt: 1, attemptNonce: randomUUID(), status: "waiting_input", sessionDir: join(attemptRoot, "session"), routingDecision: decision }],
	};
	await store.initialize(graph, snapshot);
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "model-registry.json"), JSON.stringify(routingRegistry));
	await writeFile(join(agentDir, "routing-policy.json"), JSON.stringify({
		schemaVersion: 1,
		enforcement: "require",
		profiles: { route: { candidates: [{ model: "openai/gpt-pro", thinking: "high", level: "L0" }] } },
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const bus = new CompletingBus();
	let manager: GraphManager | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		manager = managerFor(bus, graphConfig, cwd);
		// D1 frozen writer contract: a childless waiting-input attempt that still carries a
		// legacy sealed routing decision cannot be re-evaluated or re-routed in Runtime v3;
		// the frozen resume rejects instead of minting a new attempt and a new sealed decision.
		await assert.rejects(manager.resume(graph.graphId), /frozen in Runtime v3/i);
		assert.equal(bus.spawns, 0);
	} finally {
		await manager?.suspendAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const asyncDir of bus.asyncDirs) await rm(asyncDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("offline stop finalizes a prepared childless waiting-input attempt without stale attention", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-childless-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false, runtimeV2Dispatch: true };
	const graph = compileGraph({ schemaVersion: 1, graphId: "childless-stop", goal: "stop", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "out.md", sideEffect: "none" },
	] } as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	snapshot.status = "needs_attention";
	const attemptNonce = randomUUID();
	const sessionDir = store.path("nodes", "node", "attempt-1", "session");
	const failure = { kind: "routing_preflight_drift" as const, retryKind: "failed" as const };
	snapshot.nodes.node = { taskId: "node", status: "waiting_input", attempt: 1, failure, attempts: [{ attempt: 1, attemptNonce, status: "waiting_input", sessionDir, workspaceKind: "shadow", failure }] };
	await store.initialize(graph, snapshot);
	await store.writeAttemptRecord("node", 1, { schemaVersion: 2, runInstanceId: snapshot.runInstanceId, graphId: graph.graphId, taskId: "node", attempt: 1, attemptNonce, phase: "prepared", supervisorEpoch: snapshot.supervisorEpoch, fencingGeneration: snapshot.fencingGeneration, updatedAt: new Date().toISOString() });
	await store.writeWorkspaceRecord("node", 1, { schemaVersion: 2, runInstanceId: snapshot.runInstanceId, graphId: graph.graphId, taskId: "node", attempt: 1, workspaceKind: "shadow", contractDigest: "0".repeat(64), writeBaseline: {}, readBaseline: {}, inputBaseline: {}, createdAt: new Date().toISOString() });
	const stopped = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
	assert.equal(stopped.nodes.node?.status, "stopped");
	assert.equal((await store.readAttemptRecord("node", 1)).terminalStatus, "stopped");
	await rm(cwd, { recursive: true, force: true });
});

test("offline stop finalizes a prepared childless L3 waiting-input attempt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-childless-l3-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false, runtimeV2Dispatch: true };
	const graph = compileGraph({ schemaVersion: 1, graphId: "childless-l3-stop", goal: "stop", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "out.md", sideEffect: "none" },
	] } as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	snapshot.status = "needs_attention";
	const attemptNonce = randomUUID();
	const sessionDir = store.path("nodes", "node", "attempt-1", "session");
	snapshot.nodes.node = { taskId: "node", status: "waiting_input", attempt: 1, attempts: [{ attempt: 1, attemptNonce, status: "waiting_input", sessionDir, workspaceKind: "shadow" }] };
	await store.initialize(graph, snapshot);
	await store.writeAttemptRecord("node", 1, { schemaVersion: 2, runInstanceId: snapshot.runInstanceId, graphId: graph.graphId, taskId: "node", attempt: 1, attemptNonce, phase: "prepared", supervisorEpoch: snapshot.supervisorEpoch, fencingGeneration: snapshot.fencingGeneration, updatedAt: new Date().toISOString() });
	await store.writeWorkspaceRecord("node", 1, { schemaVersion: 2, runInstanceId: snapshot.runInstanceId, graphId: graph.graphId, taskId: "node", attempt: 1, workspaceKind: "shadow", contractDigest: "0".repeat(64), writeBaseline: {}, readBaseline: {}, inputBaseline: {}, createdAt: new Date().toISOString() });
	const stopped = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped");
	assert.equal(stopped.nodes.node?.status, "stopped");
	await rm(cwd, { recursive: true, force: true });
});

test("offline stop recognizes children that are already terminal before requesting abandonment", async (t) => {
	for (const fixture of [
		{ name: "failed read-only child", childState: "failed", externalWrite: false, runtimeVersion: 2, expectedGraph: "stopped", expectedNode: "stopped" },
		{ name: "complete read-only child", childState: "complete", externalWrite: false, runtimeVersion: 2, expectedGraph: "stopped", expectedNode: "stopped" },
		{ name: "complete external-write child", childState: "complete", externalWrite: true, runtimeVersion: 1, expectedGraph: "needs_attention", expectedNode: "stale" },
	] as const) await t.test(fixture.name, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-terminal-child-stop-"));
		const runs = join(cwd, "runs");
		const graphId = `terminal-child-${fixture.childState}-${fixture.externalWrite ? "external-write" : "read"}`;
		const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false, runtimeV2Dispatch: true };
		const graph = compileGraph({ schemaVersion: 1, graphId, goal: "stop terminal child", ...(fixture.externalWrite ? { contractPolicy: "strict" as const } : {}), nodes: [fixture.externalWrite ? {
			taskId: "node", agent: "worker", task: "work", capabilityId: "remote.write", acceptance: "Readback matches.", outputArtifact: "out.md", sideEffect: "external_write",
			resourceScopes: [{ kind: "service", resource: "test", access: "write" }], externalAction: { service: "test", action: "write", target: "record", requiresApproval: true, approvalRef: "approval:test", reversible: false, expectedState: "written", verifyByReadback: true },
		} : { taskId: "node", agent: "worker", task: "work", outputArtifact: "out.md", sideEffect: "local_read" }] } as GraphSpec, cwd, 2, fixture.runtimeVersion);
		const snapshot = initialSnapshot(graph, cwd, "session-id", fixture.runtimeVersion);
		const store = new GraphStore(runs, graph.graphId);
		await store.initialize(graph, snapshot);
		const attemptNonce = randomUUID();
		const attemptRoot = store.path("nodes", "node", "attempt-1");
		const sessionDir = join(attemptRoot, "session");
		const asyncId = `pi-graph-manager-terminal-${randomUUID()}`;
		const asyncDir = join(subagentAsyncRoot(), asyncId);
		await mkdir(asyncDir, { recursive: true });
		await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: fixture.childState, sessionId: "session-id", sessionDir: join(sessionDir, "child") }));
		snapshot.status = "needs_attention";
		snapshot.nodes.node = { taskId: "node", status: "running", attempt: 1, attempts: [{ attempt: 1, attemptNonce, status: "running", sessionDir, workspaceKind: "shadow", asyncId, asyncDir }] };
		await store.saveSnapshot(snapshot);
		if (snapshot.schemaVersion === 2) {
			const authority = { schemaVersion: 2 as const, runInstanceId: snapshot.runInstanceId, graphId, taskId: "node", attempt: 1, attemptNonce, supervisorEpoch: snapshot.supervisorEpoch, fencingGeneration: snapshot.fencingGeneration, updatedAt: new Date().toISOString() };
			await store.writeAttemptRecord("node", 1, { ...authority, phase: "prepared" });
			await store.writeAttemptRecord("node", 1, { ...authority, phase: "dispatching", asyncId });
			await store.writeAttemptRecord("node", 1, { ...authority, phase: "running", asyncId });
			await store.writeWorkspaceRecord("node", 1, { schemaVersion: 2, runInstanceId: snapshot.runInstanceId, graphId, taskId: "node", attempt: 1, workspaceKind: "shadow", contractDigest: "0".repeat(64), writeBaseline: {}, readBaseline: {}, inputBaseline: {}, createdAt: new Date().toISOString() });
		}
		const bus = new CompletingBus();
		try {
			const stopped = await managerFor(bus, config, cwd).stop(graph.graphId);
			assert.equal(stopped.status, fixture.expectedGraph);
			assert.equal(stopped.nodes.node?.status, fixture.expectedNode);
			assert.equal(bus.stopCalls, 0);
			if (snapshot.schemaVersion === 2) assert.equal((await store.readAttemptRecord("node", 1)).terminalStatus, fixture.expectedNode);
			if (fixture.expectedNode === "stale") assert.match(stopped.nodes.node?.error ?? "", /completed with ambient or external write authority/);
		} finally {
			await rm(asyncDir, { recursive: true, force: true });
			await rm(cwd, { recursive: true, force: true });
		}
	});
});

test("manual resume re-evaluates a childless preflight drift without reusing its sealed decision", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-routing-drift-"));
	const runs = join(cwd, "runs");
	const agentDir = join(cwd, "agent");
	const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 4, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: false };
	const routingRegistry = {
		schemaVersion: 1 as const,
		models: [
			{ model: "openai/gpt-pro", family: "gpt", provider: "openai", providerDomain: "openai", thinkingLevels: ["high" as const] },
			{ model: "ark/glm-pro", family: "glm", provider: "ark", providerDomain: "volcengine", thinkingLevels: ["high" as const] },
		],
	};
	const oldRoutingConfig: ModelRoutingConfig = {
		registry: routingRegistry,
		policy: { schemaVersion: 1, enforcement: "require", profiles: { route: { candidates: [
			{ model: "openai/gpt-pro", thinking: "high", level: "L0" },
			{ model: "ark/glm-pro", thinking: "high", level: "L1" },
		] } } },
		configDigest: "1".repeat(64),
	};
	const graph = compileGraph({ schemaVersion: 1, graphId: "routing-drift-resume", goal: "resume routing drift", workspace: "shadow", nodes: [
		{ taskId: "node", agent: "worker", task: "work", routingProfile: "route", taskRisk: "high", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const decision = evaluateRoutingPolicy(oldRoutingConfig, {
		taskBinding: graphRoutingTaskBinding({ graphId: graph.graphId, taskId: "node", task: "work" }),
		routingProfile: "route",
		taskRisk: "high",
		availableModels: [{ provider: "openai", id: "gpt-pro", reasoning: true }],
		requireAvailableModels: true,
	});
	assert.equal(decision.fallbackLevel, "L0");
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	const sessionDir = join(attemptRoot, "session");
	snapshot.status = "needs_attention";
	snapshot.nodes.node = {
		taskId: "node",
		status: "waiting_input",
		attempt: 1,
		failure: { kind: "routing_preflight_drift", retryKind: "failed" },
		attempts: [{
			attempt: 1,
			attemptNonce: randomUUID(),
			status: "waiting_input",
			sessionDir,
			routingDecision: decision,
			failure: { kind: "routing_preflight_drift", retryKind: "failed" },
			providerDispatches: [{ dispatch: 1, status: "prepared", sessionDir, startedAt: new Date().toISOString(), launchContractDigest: "a".repeat(64) }],
		}],
	};
	await store.initialize(graph, snapshot);
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "model-registry.json"), JSON.stringify(routingRegistry));
	await writeFile(join(agentDir, "routing-policy.json"), JSON.stringify({
		schemaVersion: 1,
		enforcement: "require",
		profiles: { route: { candidates: [
			{ model: "openai/gpt-pro", thinking: "high", level: "L0" },
			{ model: "ark/glm-pro", thinking: "high", level: "L1" },
		] } },
	}));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const recoveredModels = [{ provider: "ark", id: "glm-pro", reasoning: true }];
	const bus = new CompletingBus(recoveredModels);
	let manager: GraphManager | undefined;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		manager = managerFor(bus, graphConfig, cwd, recoveredModels);
		// D1 frozen writer contract: routing_preflight_drift re-evaluation is frozen in Runtime v3;
		// the sealed decision is never reused for a re-route and no new attempt is dispatched.
		await assert.rejects(manager.resume(graph.graphId), /frozen in Runtime v3/i);
		assert.equal(bus.spawns, 0);
	} finally {
		await manager?.suspendAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const asyncDir of bus.asyncDirs) await rm(asyncDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("manual L3 resume stops at the routing re-evaluation budget", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-l3-budget-"));
	const runs = join(cwd, "runs");
	const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 4, rpcTimeoutMs: 100, validationTimeoutMs: 100, notifyOnComplete: false, runtimeV2Dispatch: false };
	const routingConfig: ModelRoutingConfig = {
		registry: { schemaVersion: 1, models: [{ model: "openai/gpt-pro", family: "gpt", provider: "openai", providerDomain: "openai" }] },
		policy: { schemaVersion: 1, enforcement: "require", profiles: { route: { candidates: [{ model: "openai/gpt-pro", level: "L2" }] } } },
		configDigest: "2".repeat(64),
	};
	const graph = compileGraph({ schemaVersion: 1, graphId: "l3-budget", goal: "budget", nodes: [
		{ taskId: "node", agent: "worker", task: "work", routingProfile: "route", taskRisk: "high", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const decision = evaluateRoutingPolicy(routingConfig, {
		taskBinding: graphRoutingTaskBinding({ graphId: graph.graphId, taskId: "node", task: "work" }),
		routingProfile: "route",
		taskRisk: "high",
	});
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	snapshot.status = "needs_attention";
	snapshot.nodes.node = {
		taskId: "node",
		status: "waiting_input",
		attempt: 2,
		attempts: [
			{ attempt: 1, status: "failed", sessionDir: store.path("nodes", "node", "attempt-1", "session"), routingDecision: decision, failure: { kind: "task_failed", retryKind: "failed" } },
			{ attempt: 2, status: "waiting_input", sessionDir: store.path("nodes", "node", "attempt-2", "session"), routingDecision: decision },
		],
	};
	await store.initialize(graph, snapshot);
	try {
		// D1 frozen writer contract: L3 routing re-evaluation has no governance budget anymore;
		// the frozen resume rejects before any new attempt instead of counting re-evaluation spend.
		await assert.rejects(() => managerFor(new ControllableBus(), graphConfig, cwd).resume(graph.graphId), /frozen in Runtime v3/i);
		const persisted = await store.loadSnapshot();
		assert.equal(persisted.nodes.node?.status, "waiting_input");
		assert.equal(persisted.nodes.node?.attempt, 2);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("current and legacy Pi session identities remain distinct during migration", () => {
	const context = { sessionManager: { getSessionId: () => "session-id", getSessionFile: () => "/tmp/session.jsonl" } } as any;
	assert.equal(sessionIdentity(context), "session-id");
	assert.equal(legacySessionIdentity(context), "/tmp/session.jsonl");
});

test("new graphs bind to Pi's session id instead of the session file path", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-session-id-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 20,
		validationTimeoutMs: 100,
		notifyOnComplete: false,
		runtimeV2Dispatch: false,
	};
	const productionManager = new GraphManager({ events: new ControllableBus(), sendMessage() {} } as any);
	Object.assign(productionManager as any, {
		config,
		context: {
			cwd,
			modelRegistry: { getAvailable: () => [] },
			sessionManager: { getSessionFile: () => "session", getSessionId: () => "session-id" },
			ui: { notify() {} },
		},
	});
	await assert.rejects(() => productionManager.start({
		schemaVersion: 1, graphId: "unplanned", goal: "unplanned",
		nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}), /reviewed planning receipt/);
	const manager = managerFor(new ControllableBus(), config, cwd);
	const snapshot = await manager.start({
		schemaVersion: 1,
		graphId: "session-identity",
		goal: "identity",
		nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	});
	assert.equal(snapshot.sessionId, "session-id");
	await manager.suspendAll();
});

test("session shutdown aborts an admitted Graph start before any child launch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-start-shutdown-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const bus = new CompletingBus();
	const manager = managerFor(bus, config, cwd);
	let releaseRouting!: () => void;
	let routingStarted!: () => void;
	const routingReady = new Promise<void>((resolve) => { routingStarted = resolve; });
	const routingGate = new Promise<void>((resolve) => { releaseRouting = resolve; });
	// D1: the pre-launch admission gate no longer runs through routingConfigFor (removed);
	// gate the durable Supervisor claim that every admitted start takes before launch instead.
	const originalAcquire = GraphStore.prototype.acquireSupervisor;
	(GraphStore.prototype as any).acquireSupervisor = async function (this: GraphStore, epoch: string) {
		routingStarted();
		await routingGate;
		return originalAcquire.call(this, epoch);
	};
	const starting = manager.start({
		schemaVersion: 1,
		graphId: "shutdown-before-launch",
		goal: "do not cross the old session boundary",
		nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	});
	await routingReady;
	const shutdown = manager.suspendAll();
	releaseRouting();
	await shutdown;
	(GraphStore.prototype as any).acquireSupervisor = originalAcquire;
	await assert.rejects(starting, /session changed/i);
	assert.equal(bus.spawns, 0);
	assert.deepEqual(manager.listActiveWork(), []);
	await rm(cwd, { recursive: true, force: true });
});

test("session shutdown durably stops a Graph persisted before launch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-persisted-start-shutdown-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const bus = new CompletingBus();
	const manager = managerFor(bus, config, cwd);
	const original = GraphStore.prototype.initialize;
	let persisted!: () => void;
	let release!: () => void;
	const persistedReady = new Promise<void>((resolve) => { persisted = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	GraphStore.prototype.initialize = async function (...args: Parameters<GraphStore["initialize"]>) {
		await original.apply(this, args);
		persisted();
		await gate;
	};
	try {
		const starting = manager.start({
			schemaVersion: 1,
			graphId: "persisted-shutdown-before-launch",
			goal: "do not orphan the admitted run",
			nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
		});
		await persistedReady;
		const shutdown = manager.suspendAll();
		release();
		await shutdown;
		await assert.rejects(starting, /durably stopped/i);
		const stored = await new GraphStore(runs, "persisted-shutdown-before-launch").loadSnapshot();
		assert.equal(stored.status, "stopped");
		assert.equal(stored.nodes.read?.status, "stopped");
		assert.equal(bus.spawns, 0);
	} finally {
		GraphStore.prototype.initialize = original;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("session shutdown aborts Graph resume before any recovered child launch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-resume-shutdown-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const bus = new CompletingBus();
	const manager = managerFor(bus, config, cwd);
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "resume-shutdown-before-launch",
		goal: "do not resume across the old session boundary",
		nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, cwd, config.maxSpawnBudget, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	let releaseRouting!: () => void;
	let routingStarted!: () => void;
	const routingReady = new Promise<void>((resolve) => { routingStarted = resolve; });
	const routingGate = new Promise<void>((resolve) => { releaseRouting = resolve; });
	// D1: the resume admission gate no longer runs through routingConfigFor (removed);
	// gate the durable Supervisor claim that every admitted resume takes before any recovered launch.
	const originalAcquire = GraphStore.prototype.acquireSupervisor;
	(GraphStore.prototype as any).acquireSupervisor = async function (this: GraphStore, epoch: string) {
		routingStarted();
		await routingGate;
		return originalAcquire.call(this, epoch);
	};
	const resuming = manager.resume(graph.graphId);
	await routingReady;
	const shutdown = manager.suspendAll();
	releaseRouting();
	await shutdown;
	(GraphStore.prototype as any).acquireSupervisor = originalAcquire;
	await assert.rejects(resuming, /session changed/i);
	assert.equal(bus.spawns, 0);
	assert.deepEqual(manager.listActiveWork(), []);
	await rm(cwd, { recursive: true, force: true });
});

test("closing an old lifecycle generation waits for its background work without clearing a newer session", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-generation-"));
	const config: GraphConfig = { enabled: true, runsDir: join(cwd, "runs"), maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 1, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	const oldContext = (manager as any).context;
	let release!: () => void;
	let observedAbort = false;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	void (manager as any).runBackground(0, async (signal: AbortSignal) => {
		await gate;
		observedAbort = signal.aborted;
	});
	const closing = manager.suspendAll();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const newContext = { ...oldContext, sessionManager: { getSessionFile: () => "new-session", getSessionId: () => "new-session-id" } };
	Object.assign(manager as any, { context: newContext, lifecycleGeneration: 2 });
	release();
	await closing;
	assert.equal(observedAbort, true);
	assert.equal((manager as any).context, newContext);
	await rm(cwd, { recursive: true, force: true });
});

test("a newer initialize does not dispose an old generation reaper before its own shutdown drains", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-overlap-reaper-"));
	const config: GraphConfig = { enabled: true, runsDir: join(cwd, "runs"), maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 1, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	let disposed = 0;
	(manager as any).recoveryChildRuntimes.set(0, { dispose() { disposed += 1; } });
	const oldContext = (manager as any).context;
	const newContext = { ...oldContext, sessionManager: { getSessionFile: () => "new-session", getSessionId: () => "new-session-id" } };
	(manager as any).initializeGeneration = async () => undefined;
	await manager.initialize(newContext);
	assert.equal(disposed, 0);
	await manager.suspendAll();
	assert.equal(disposed, 1);
	await rm(cwd, { recursive: true, force: true });
});

test("recovery does not acquire a Supervisor claim for a corrupt foreign-owned projection", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-foreign-corrupt-recovery-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false, runtimeV2Dispatch: true };
	const graph = compileGraph({ schemaVersion: 1, graphId: "foreign-corrupt-recovery", goal: "foreign", nodes: [
		{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" },
	] } as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "foreign-session", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	await writeFile(store.path("snapshot.json"), "{corrupt");
	const manager = managerFor(new ControllableBus(), config, cwd);
	const original = GraphStore.prototype.acquireSupervisor;
	let claims = 0;
	GraphStore.prototype.acquireSupervisor = async function (epoch: string) {
		claims += 1;
		return original.call(this, epoch);
	};
	try {
		await (manager as any).adoptGraph(graph.graphId, new GraphStore(runs, graph.graphId), "session-id", "session", config, (manager as any).context, 0, new AbortController().signal);
		assert.equal(claims, 0);
	} finally {
		GraphStore.prototype.acquireSupervisor = original;
		await rm(cwd, { recursive: true, force: true });
	}
});

test("Manager keeps recovery tombstone reapers alive until the owning lifecycle shuts down", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-recovery-reaper-"));
	const config: GraphConfig = { enabled: true, runsDir: join(cwd, "runs"), maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 1, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	const attemptRoot = join(cwd, "attempt-1");
	const lineage = {
		runInstanceId: randomUUID(),
		graphId: "recovery-reaper",
		taskId: "node",
		attempt: 1,
		attemptNonce: randomUUID(),
		sessionDir: join(attemptRoot, "session"),
		ownerSessionId: "session-id",
	};
	const requestDigest = "a".repeat(64);
	await mkdir(attemptRoot, { recursive: true });
	await writeFile(join(attemptRoot, "child-tombstone.json"), JSON.stringify({
		schemaVersion: 1,
		dispatchKey: canonicalDigest({ lineage, requestDigest }),
		requestDigest,
		lineage,
		abandonedAt: new Date().toISOString(),
		reason: "recovery must keep enforcing the tombstone",
	}));
	const runtime = (manager as any).recoveryChildRuntime(0, config);
	Object.assign(runtime, { reaperDelayMs: 5, reaperMaxAgeMs: 1_000, stopConfirmationMs: 5 });
	assert.deepEqual(await runtime.enforceTombstone(lineage), { stopped: false });
	assert.equal((manager as any).recoveryChildRuntimes.get(0), runtime);

	const asyncId = `manager-recovery-reaper-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "session-id", sessionDir: join(lineage.sessionDir, "child") }));
	const deadline = Date.now() + 1_000;
	while (Date.now() < deadline) {
		try {
			assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
			break;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	assert.equal(JSON.parse(await readFile(join(asyncDir, "control", "stop.json"), "utf8")).type, "stop");
	await manager.suspendAll();
	assert.equal((manager as any).recoveryChildRuntimes.size, 0);
	await rm(asyncDir, { recursive: true, force: true });
	await rm(cwd, { recursive: true, force: true });
});

test("Manager retains a terminal Runner only while its tombstone reaper remains active", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-retired-reaper-"));
	const config: GraphConfig = { enabled: true, runsDir: join(cwd, "runs"), maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 1, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	let disposeCalls = 0;
	const runner = { dispose: ({ preserveReapers }: { preserveReapers?: boolean } = {}) => {
		disposeCalls += 1;
		return Boolean(preserveReapers);
	} } as unknown as GraphRunner;
	(manager as any).retireRunnerReapers(0, runner);
	assert.equal(disposeCalls, 1);
	assert.equal((manager as any).retiredReaperRunners.get(0).has(runner), true);
	await manager.suspendAll();
	assert.equal(disposeCalls, 2);
	assert.equal((manager as any).retiredReaperRunners.size, 0);
	await rm(cwd, { recursive: true, force: true });
});

test("session shutdown rejects start and resume calls admitted after closing begins", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-closing-admission-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 100, validationTimeoutMs: 100, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	const graph = compileGraph({ schemaVersion: 1, graphId: "closing-resume", goal: "closing", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	await new GraphStore(runs, graph.graphId).initialize(graph, initialSnapshot(graph, cwd, "session-id"));
	const closing = manager.suspendAll();
	await assert.rejects(() => manager.start({ schemaVersion: 1, graphId: "closing-start", goal: "closing", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "node.md", sideEffect: "none" },
	] }), /shutdown is in progress/);
	await assert.rejects(() => manager.resume(graph.graphId), /shutdown is in progress/);
	await closing;
	await rm(cwd, { recursive: true, force: true });
});

test("active stop checks ownership and converts a suspended non-terminal result into durable stop", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-active-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 100, validationTimeoutMs: 100, notifyOnComplete: false };
	const manager = managerFor(new ControllableBus(), config, cwd);
	const graph = compileGraph({ schemaVersion: 1, graphId: "active-stop", goal: "stop", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const foreign = initialSnapshot(graph, cwd, "foreign-session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, foreign);
	(manager as any).runners.set(graph.graphId, { runner: { snapshot: foreign, beginStop() {}, stop() {} }, promise: Promise.resolve(foreign) });
	await assert.rejects(() => manager.stop(graph.graphId), /owns this graph/);
	const owned = { ...foreign, sessionId: "session-id" };
	owned.nodes = structuredClone(foreign.nodes);
	await store.saveSnapshot(owned);
	(manager as any).runners.set(graph.graphId, { runner: { snapshot: owned, beginStop() {}, stop() {} }, promise: Promise.resolve(owned) });
	const stopped = await manager.stop(graph.graphId);
	assert.equal(stopped.status, "stopped");
	assert.equal((await store.loadSnapshot()).status, "stopped");
	await rm(cwd, { recursive: true, force: true });
});

test("Manager refreshes the Pi model registry for each routed Graph node", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-live-models-"));
	const runs = join(cwd, "runs");
	const agentDir = join(cwd, "agent");
	const allVisionModels = [
		{ provider: "openai", id: "gpt-pro", reasoning: true, input: ["text", "image"] as Array<"text" | "image"> },
		{ provider: "kimi", id: "k-pro", reasoning: true, input: ["text", "image"] as Array<"text" | "image"> },
	];
	await mkdir(agentDir, { recursive: true });
	await writeFile(join(agentDir, "model-registry.json"), JSON.stringify({
		schemaVersion: 1,
		models: [
			{ model: "openai/gpt-pro", family: "gpt", provider: "openai", providerDomain: "openai", thinkingLevels: ["high"], inputModalities: ["text", "image"] },
			{ model: "kimi/k-pro", family: "kimi", provider: "kimi", providerDomain: "moonshot", thinkingLevels: ["high"], inputModalities: ["text", "image"] },
		],
	}));
	await writeFile(join(agentDir, "routing-policy.json"), JSON.stringify({
		schemaVersion: 1,
		enforcement: "require",
		profiles: {
			image: {
				candidates: [
					{ model: "openai/gpt-pro", thinking: "high", level: "L0" },
					{ model: "kimi/k-pro", thinking: "high", level: "L1" },
				],
				constraints: { requiredInputModalities: ["image"] },
			},
		},
	}));
	const graphConfig: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 4, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const bus = new CompletingBus(allVisionModels);
	let registryReads = 0;
	const liveModels = () => {
		registryReads += 1;
		return bus.models.length === 0 ? allVisionModels : [allVisionModels[1]!];
	};
	const manager = managerFor(bus, graphConfig, cwd, liveModels);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await manager.start({
			schemaVersion: 1,
			graphId: "live-image-models",
			goal: "refresh image capability",
			workspace: "shadow",
			nodes: [
				{ taskId: "first", agent: "multimodal-analyzer", task: "inspect first image", routingProfile: "image", outputArtifact: "first.md", sideEffect: "none" },
				{ taskId: "second", agent: "multimodal-analyzer", task: "inspect second image", routingProfile: "image", dependsOn: ["first"], outputArtifact: "second.md", sideEffect: "none" },
			],
		});
		const store = new GraphStore(runs, "live-image-models");
		const deadline = Date.now() + 15_000;
		let terminal = await store.loadSnapshot();
		while (["queued", "running"].includes(terminal.status) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			terminal = await store.loadSnapshot();
		}
		assert.equal(terminal.status, "needs_attention", JSON.stringify(terminal));
		assert.deepEqual(bus.models, []);
		assert.equal(bus.spawns, 0);
	} finally {
		await manager.suspendAll();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		for (const asyncDir of bus.asyncDirs) await rm(asyncDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	}
});

test("runner persists needs_attention before releasing its Supervisor after an internal failure", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-runner-failure-state-"));
	const runs = join(cwd, "runs");
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "runtime-failure-state",
		goal: "failure state",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	}, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	(store as any).readDesiredState = async () => { throw new Error("control plane read failed"); };
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	await assert.rejects(new GraphRunner(graph, snapshot, store, new ControllableBus(), new LeaseRegistry(join(runs, ".control", "leases")), config).run(), /control plane read failed/);
	const persisted = await new GraphStore(runs, graph.graphId).loadSnapshot();
	assert.equal(persisted.status, "needs_attention");
	assert.match(persisted.error ?? "", /control plane read failed/);
});

test("manual resume cannot bypass retry budget or non-idempotent writes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-"));
	const graph = compileGraph({ schemaVersion: 1, contractPolicy: "strict", goal: "resume", nodes: [
		{ taskId: "safe", agent: "worker", task: "safe", capabilityId: "work.safe", acceptance: "Output is complete.", outputArtifact: "safe.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
		{ taskId: "unsafe", agent: "worker", task: "unsafe", capabilityId: "external.write", acceptance: "Readback matches expected state.", outputArtifact: "unsafe.md", sideEffect: "external_write", idempotent: false, resourceScopes: [{ kind: "service", resource: "test-service", access: "write" }], externalAction: { service: "test-service", action: "send", target: "target", requiresApproval: true, approvalRef: "approval:test", reversible: false, expectedState: "sent", verifyByReadback: true } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd);
	snapshot.nodes.safe!.attempt = 1;
	assert.doesNotThrow(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!));
	snapshot.nodes.safe!.attempt = 2;
	assert.throws(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!), /exhausted/);
	assert.throws(() => assertRedispatchAllowed(graph.nodes[1]!, snapshot.nodes.unsafe!), /external write authority/);
	snapshot.nodes.safe!.attempt = 1;
	graph.nodes[0]!.retryPolicy.retryOn = ["failed"];
	assert.throws(() => assertRedispatchAllowed(graph.nodes[0]!, snapshot.nodes.safe!, "dispatch"), /not authorized by retryOn/);
});

test("recovery recompiles persisted graphs and rejects path tampering", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-manager-recovery-"));
	const runs = join(root, "runs");
	const graph = compileGraph({ schemaVersion: 1, graphId: "tampered", goal: "recover", nodes: [
		{ taskId: "safe", agent: "worker", task: "safe", outputArtifact: "safe.md", sideEffect: "none" },
	] } as GraphSpec, root);
	const snapshot = initialSnapshot(graph, root);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	await writeFile(store.path("graph.json"), JSON.stringify({ ...graph, nodes: [{ ...graph.nodes[0], outputArtifact: "../../../escape.md" }] }));
	await assert.rejects(() => loadValidatedGraph(store, snapshot, 20), /outputArtifact/);
});

test("an offline manager sends stop control to the active Supervisor", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 1_000, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "controlled-stop", goal: "stop", workspace: "shadow", nodes: [
		{ taskId: "running", agent: "worker", task: "keep running", outputArtifact: "running.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new ControllableBus();
	const runner = new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, "leases.json")), config);
	const running = runner.run();
	while (!bus.started) await new Promise((resolve) => setTimeout(resolve, 5));
	const stopped = await managerFor(bus, config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped");
	assert.equal((await running).status, "stopped");
	assert.equal((await store.loadSnapshot()).status, "stopped");
});

test("a foreign Supervisor stop persists desired state before transient control", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-durable-foreign-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "durable-foreign-stop", goal: "stop", nodes: [
		{ taskId: "node", agent: "worker", task: "work", outputArtifact: "out.md", sideEffect: "none" },
	] } as GraphSpec, cwd, 2);
	const store = new GraphStore(runs, graph.graphId);
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	await store.initialize(graph, snapshot);
	const release = await store.acquireSupervisor("foreign-supervisor");
	const manager = managerFor(new ControllableBus(), config, cwd);
	const stopping = manager.stop(graph.graphId);
	const deadline = Date.now() + 1_000;
	while (await store.readDesiredState() !== "stopped" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(await store.readDesiredState(), "stopped");
	snapshot.status = "stopped";
	snapshot.nodes.node!.status = "stopped";
	await store.saveSnapshot(snapshot);
	assert.equal((await stopping).status, "stopped");
	await release();
	await manager.suspendAll();
	await rm(cwd, { recursive: true, force: true });
});

test("stop preserves stale attention and terminal graph states", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-terminal-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "terminal-stop", goal: "terminal", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.status = "needs_attention";
	const attemptRoot = join(runs, graph.graphId, "nodes", "node", "attempt-1");
	snapshot.nodes.node = { taskId: "node", status: "stale", attempt: 1, attempts: [{ attempt: 1, status: "stale", sessionDir: join(attemptRoot, "session") }] };
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const manager = managerFor(new ControllableBus(), config, cwd);
	assert.equal((await manager.stop(graph.graphId)).status, "needs_attention");
	const persisted = await store.loadSnapshot();
	persisted.status = "complete";
	persisted.nodes.node!.status = "accepted";
	persisted.nodes.node!.attempts[0]!.status = "accepted";
	await store.saveSnapshot(persisted);
	assert.equal((await manager.stop(graph.graphId)).status, "complete");
});

test("offline v2 stop commits terminal attempt authority before saving its snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-v2-offline-stop-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 1_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-offline-stop",
		goal: "stop",
		nodes: [{ taskId: "read", agent: "scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	} as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	if (snapshot.schemaVersion !== 2) throw new Error("Expected v2 snapshot.");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptNonce = randomUUID();
	const attemptRoot = store.path("nodes", "read", "attempt-1");
	const asyncId = `pi-graph-manager-resource-wait-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "session-id" }));
	snapshot.status = "needs_attention";
	snapshot.nodes.read = {
		taskId: "read",
		status: "resource_wait",
		attempt: 1,
		attempts: [{
			attempt: 1,
			attemptNonce,
			status: "running",
			sessionDir: join(attemptRoot, "session"),
			workspaceKind: "shadow",
			asyncId,
			asyncDir,
		}],
	};
	await store.saveSnapshot(snapshot);
	const base = {
		schemaVersion: 2 as const,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		attemptNonce,
		supervisorEpoch: snapshot.supervisorEpoch,
		fencingGeneration: snapshot.fencingGeneration,
		updatedAt: new Date().toISOString(),
	};
	await store.writeAttemptRecord("read", 1, { ...base, phase: "prepared" });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "dispatching", asyncId });
	await store.writeAttemptRecord("read", 1, { ...base, phase: "running", asyncId });
	await store.writeWorkspaceRecord("read", 1, {
		schemaVersion: 2,
		runInstanceId: snapshot.runInstanceId,
		graphId: graph.graphId,
		taskId: "read",
		attempt: 1,
		workspaceKind: "shadow",
		contractDigest: "0".repeat(64),
		writeBaseline: {},
		readBaseline: {},
		inputBaseline: {},
		createdAt: new Date().toISOString(),
	});
	const stopped = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
	assert.equal(stopped.nodes.read?.status, "stopped");
	assert.equal((await store.readAttemptRecord("read", 1)).terminalStatus, "stopped");
	assert.equal((await loadValidatedRun(store, 2)).snapshot.status, "stopped");
});

test("offline stop validates and preserves accepted authority ahead of a needs-attention snapshot", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-v2-offline-accepted-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = {
		enabled: true,
		runsDir: runs,
		maxConcurrency: 1,
		readOnlyBurst: 1,
		maxSpawnBudget: 2,
		rpcTimeoutMs: 100,
		validationTimeoutMs: 1_000,
		notifyOnComplete: false,
		runtimeV2Dispatch: true,
	};
	const graph = compileGraph({
		schemaVersion: 1,
		graphId: "v2-offline-accepted",
		goal: "accepted stop",
		nodes: [{ taskId: "read", agent: "code-scout", task: "read", outputArtifact: "read.md", sideEffect: "local_read" }],
	} as GraphSpec, cwd, 2, 2);
	const snapshot = initialSnapshot(graph, cwd, "session-id", 2);
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const bus = new CompletingBus();
	const complete = await new GraphRunner(graph, snapshot, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run();
	const recoveryStore = new GraphStore(runs, graph.graphId);
	complete.status = "needs_attention";
	complete.nodes.read!.status = "verifying";
	complete.nodes.read!.attempts[0]!.status = "verifying";
	await recoveryStore.saveSnapshot(complete);
	assert.equal((await loadValidatedRun(recoveryStore, 2)).snapshot.status, "needs_attention");
	const stopped = await managerFor(bus, config, cwd).stop(graph.graphId);
	assert.equal(stopped.status, "complete");
	assert.equal(stopped.nodes.read?.status, "accepted");
	assert.equal((await recoveryStore.readAttemptRecord("read", 1)).phase, "accepted");
	assert.equal(bus.stopCalls, 0);
	assert.equal((await loadValidatedRun(recoveryStore, 2)).snapshot.status, "complete");
	const asyncDir = stopped.nodes.read?.attempts[0]?.asyncDir;
	if (asyncDir) {
		assert.equal(JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8")).state, "complete");
		await rm(asyncDir, { recursive: true, force: true });
	}
});

test("offline stop preserves an interrupted apply as recoverable attention", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-applying-"));
	const runs = join(cwd, "runs");
	await writeFile(join(cwd, "target.md"), "after\n");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "applying-stop", goal: "apply", workspace: "shadow", nodes: [{
		taskId: "write", agent: "worker", task: "write", outputArtifact: "result.md", sideEffect: "local_write",
		writeScope: [{ kind: "file", path: "target.md" }], validationCommands: ["test -f target.md"],
	}] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "write", "attempt-1");
	await mkdir(join(attemptRoot, "session"), { recursive: true });
	snapshot.status = "running";
	snapshot.nodes.write = { taskId: "write", status: "verifying", attempt: 1, attempts: [{ attempt: 1, status: "verifying", sessionDir: join(attemptRoot, "session"), workspaceDir: join(attemptRoot, "workspace"), workspaceKind: "shadow", outputPath: join(attemptRoot, "output", "result.md") }] };
	await store.saveSnapshot(snapshot);
	await writeFile(join(attemptRoot, "apply-plan.json"), JSON.stringify({ version: 1, status: "applying", applyingIndex: 0, entries: [{ sourcePath: join(cwd, "target.md"), before: "a".repeat(64), after: "b".repeat(64) }] }));
	const result = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
	assert.equal(result.status, "needs_attention");
	assert.equal(result.nodes.write?.status, "stale");
	assert.match(result.nodes.write?.error ?? "", /Durable stop could not recover source apply/);
});

test("offline stop reloads state after acquiring the Supervisor claim", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-stop-race-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "stop-race", goal: "race", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	snapshot.status = "running";
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const original = GraphStore.prototype.acquireSupervisor;
	GraphStore.prototype.acquireSupervisor = async function (epoch: string) {
		const releaseInjection = await original.call(this, `state-change-${epoch}`);
		const latest = await this.loadSnapshot();
		latest.status = "blocked";
		latest.nodes.node!.status = "blocked";
		await this.saveSnapshot(latest);
		await releaseInjection();
		return original.call(this, epoch);
	};
	try {
		const result = await managerFor(new ControllableBus(), config, cwd).stop(graph.graphId);
		assert.equal(result.status, "blocked");
		assert.equal((await store.loadSnapshot()).status, "blocked");
	} finally {
		GraphStore.prototype.acquireSupervisor = original;
	}
});

test("manual resume cannot replace a missing child from a stale attempt", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-missing-child-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 2, readOnlyBurst: 2, maxSpawnBudget: 20, rpcTimeoutMs: 100, validationTimeoutMs: 1_000, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "missing-child", goal: "resume", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none", retryPolicy: { maxAttempts: 2 } },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session");
	const store = new GraphStore(runs, graph.graphId);
	await store.initialize(graph, snapshot);
	const attemptRoot = store.path("nodes", "node", "attempt-1");
	const asyncId = "missing-child-run";
	snapshot.status = "needs_attention";
	snapshot.nodes.node = { taskId: "node", status: "stale", attempt: 1, attempts: [{ attempt: 1, status: "stale", sessionDir: join(attemptRoot, "session"), asyncId, asyncDir: join(subagentAsyncRoot(), asyncId) }] };
	await store.saveSnapshot(snapshot);
	await assert.rejects(() => managerFor(new ControllableBus(), config, cwd).resume(graph.graphId), /will not replace/);
	const persisted = await store.loadSnapshot();
	assert.equal(persisted.nodes.node?.status, "stale");
	assert.equal(persisted.nodes.node?.attempt, 1);
});

test("manual resume recovers waiting-input child identity before deciding whether to relaunch", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-graph-manager-waiting-child-recovery-"));
	const runs = join(cwd, "runs");
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 20, validationTimeoutMs: 100, notifyOnComplete: false };
	const graph = compileGraph({ schemaVersion: 1, graphId: "waiting-child-recovery", goal: "resume", nodes: [
		{ taskId: "node", agent: "worker", task: "node", outputArtifact: "node.md", sideEffect: "none" },
	] } as GraphSpec, cwd);
	const snapshot = initialSnapshot(graph, cwd, "session-id");
	const store = new GraphStore(runs, graph.graphId);
	const sessionDir = store.path("nodes", "node", "attempt-1", "session");
	snapshot.status = "needs_attention";
	snapshot.nodes.node = { taskId: "node", status: "waiting_input", attempt: 1, attempts: [{ attempt: 1, status: "waiting_input", sessionDir }] };
	await store.initialize(graph, snapshot);
	const asyncId = `waiting-child-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "paused", sessionId: "session-id", sessionDir }));
	const bus = new CompletingBus();
	try {
		await assert.rejects(() => managerFor(bus, config, cwd).resume(graph.graphId), /still paused/);
		assert.equal(bus.spawns, 0);
	} finally {
		await rm(asyncDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	}
});
