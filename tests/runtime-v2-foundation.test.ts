import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
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
import { authorizationFor, canonicalDigest } from "../src/authority.ts";
import { loadValidatedRun } from "../src/reconciler.ts";
import { prepareAttentionResume, readHistory, updateHistoryFlag } from "../src/retention.ts";
import { canonicalJson, PlanningGate, graphSpecDigest, type PlanningReceipt, type TaskAssessment } from "../src/subagent-router/planning-gate.ts";

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

function lineageDigestFor(receipt: PlanningReceipt): string {
	return createHash("sha256").update(canonicalJson({
		configDigest: receipt.configDigest,
		effectiveRiskClass: receipt.effectiveRiskClass,
		effectiveTier: receipt.effectiveTier,
		finalGraphSpecDigest: receipt.finalGraphSpecDigest,
		flashAssessmentDigest: receipt.flashAssessmentDigest,
		lockedContextDigest: receipt.lockedContextDigest,
		parentDraftDigest: receipt.parentDraftDigest,
		parentModel: receipt.parentModel,
		planner: receipt.planner,
		plannerOutputDigest: receipt.plannerOutputDigest,
		planningProfile: receipt.planningProfile,
		postHardFloor: receipt.postHardFloor,
		postRiskFloor: receipt.postRiskFloor,
		preHardFloor: receipt.preHardFloor,
		preRiskFloor: receipt.preRiskFloor,
		promptDigest: receipt.promptDigest,
	})).digest("hex");
}

test("v2 snapshot round-trips a ready node before its first attempt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-ready-roundtrip-"));
	const graph = graphAt(root, "ready-roundtrip");
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	const state = snapshot(graph, root);
	await store.initialize(graph, state);
	state.status = "running";
	state.nodes.write!.status = "ready";
	await store.saveSnapshot(state);
	const loaded = await store.loadSnapshot();
	assert.equal(loaded.nodes.write?.status, "ready");
	assert.equal(loaded.nodes.write?.attempt, 0);
	assert.deepEqual(loaded.nodes.write?.attempts, []);
});

test("needs_attention uses attentionAt and does not reuse a terminal timestamp after resume", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-attention-time-"));
	const graph = graphAt(root, "attention-time");
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	const state = snapshot(graph, root);
	await store.initialize(graph, state);
	state.status = "needs_attention";
	await store.saveSnapshot(state);
	assert.match(state.attentionAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
	assert.equal(state.terminalAt, undefined);
	const attentionAt = state.attentionAt;
	state.status = "queued";
	await store.saveSnapshot(state);
	assert.equal(state.attentionAt, undefined);
	assert.equal(state.terminalAt, undefined);
	state.status = "failed";
	await store.saveSnapshot(state);
	assert.match(state.terminalAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
	assert.notEqual(state.terminalAt, attentionAt);
});

test("legacy attention terminal timestamps are cleared transactionally with retained history", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-attention-history-"));
	const runs = join(root, "runs");
	const graph = graphAt(root, "attention-history");
	const store = new GraphStore(runs, graph.graphId);
	const state = snapshot(graph, root);
	state.status = "needs_attention";
	state.terminalAt = state.updatedAt;
	state.attentionAt = state.updatedAt;
	await store.initialize(graph, state);
	await updateHistoryFlag(runs, graph.graphId, "pin");
	const release = await store.acquireSupervisor("attention-resume");
	try {
		const resumable = await store.loadSnapshot();
		assert.equal((await readHistory(store, resumable)).terminalAt, resumable.schemaVersion === 2 ? resumable.terminalAt : undefined);
		await prepareAttentionResume(store, resumable);
		const migrated = await store.loadSnapshot();
		const history = await readHistory(store, migrated);
		assert.equal(migrated.schemaVersion === 2 ? migrated.terminalAt : undefined, undefined);
		assert.equal(history.terminalAt, undefined);
		assert.ok(history.pinnedAt, "unrelated history flags must survive the migration");
		assert.equal(migrated.schemaVersion === 2 ? migrated.lifecycleRevision : undefined, history.revision);
	} finally {
		await release();
	}
});

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

test("PlanningGate receipts round-trip through durable Graph authorization", () => {
	const root = "/workspace";
	const sourceSpec = {
		schemaVersion: 1 as const,
		graphId: "planning-gate-roundtrip",
		goal: "inspect the requested change",
		nodes: [{ taskId: "inspect", agent: "task-executor", task: "inspect", outputArtifact: "inspect.md", sideEffect: "none" as const }],
	};
	const gate = new PlanningGate();
	const assessment: TaskAssessment = {
		schemaVersion: 1, taskType: "general", proposedTier: "tactical", confidence: 0.9,
		reasons: ["multiple steps"], plannedActions: ["inspect", "report"], complexitySignals: {},
		riskClass: "R0", riskReasons: [], riskSignals: {},
	};
	const parentModel = { resolvedModel: "deepseek/deepseek-v4-flash:max", modelFamily: "deepseek", providerDomain: "deepseek", identityConfidence: "runtime_reported" as const };
	const planner = { decisionId: "planner", resolvedModel: "kimi-coding/k3:high", attemptedModels: ["kimi-coding/k3:high"], modelFamily: "kimi", providerDomain: "moonshot" };
	const reviewer = { decisionId: "reviewer", resolvedModel: "wisdomrouter/gpt-5.6-sol:high", attemptedModels: ["wisdomrouter/gpt-5.6-sol:high"], modelFamily: "gpt", providerDomain: "wisdomrouter" };
	const configDigest = "c".repeat(64);
	gate.beginTurn({ sessionId: "session", cwd: root, prompt: "Inspect and report." });
	gate.assessTurn({ sessionId: "session", cwd: root, assessment, draftSpec: sourceSpec, parentModel });
	gate.beginPlanning({ sessionId: "session", cwd: root, configDigest, planningProfile: "tactical-planning", expectedPlannerModel: planner.resolvedModel });
	gate.completePlanning({ sessionId: "session", cwd: root, configDigest, evidence: planner, output: "# Plan\n- inspect" });
	const reviewBinding = gate.beginReview({ sessionId: "session", cwd: root, configDigest, spec: sourceSpec });
	const receipt = gate.completeReview({
		sessionId: "session", cwd: root, configDigest, reviewer,
		review: { schemaVersion: 2, reviewedDigest: reviewBinding.digest, lineageDigest: reviewBinding.lineageDigest, verdict: "pass", findings: [] },
	});
	const graph = compileGraph(sourceSpec, root, 20, 2);
	const state = snapshot(graph, root);
	state.sessionId = "session";
	assert.doesNotThrow(() => authorizationFor(graph, state, receipt, graphSpecDigest(sourceSpec)));
});

test("v2 authorization durably binds and validates the planning receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-planning-auth-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "planning-authority");
	const state = snapshot(graph, root);
	const digest = "a".repeat(64);
	const receipt: PlanningReceipt = {
		schemaVersion: 2, receiptId: randomUUID(), sessionId: "session", cwd: root, promptDigest: digest, lockedContextDigest: digest, configDigest: digest,
		flashProposedTier: "strategic", flashConfidence: 0.9, preHardFloor: "strategic", postHardFloor: "tactical", effectiveTier: "strategic",
		flashProposedRisk: "R1", preRiskFloor: "R1", postRiskFloor: "R1", effectiveRiskClass: "R1",
		flashAssessmentDigest: digest, parentDraftDigest: digest, plannerOutputDigest: digest, finalGraphSpecDigest: digest, lineageDigest: digest,
		planningProfile: "strategic-planning", planner: { decisionId: "p", resolvedModel: "wisdomrouter/gpt-5.6-sol:high", attemptedModels: ["wisdomrouter/gpt-5.6-sol:high"], modelFamily: "gpt", providerDomain: "wisdomrouter" },
		parentModel: { resolvedModel: "deepseek/deepseek-v4-flash:max", modelFamily: "deepseek", providerDomain: "deepseek", identityConfidence: "runtime_reported" },
		reviewer: { decisionId: "r", resolvedModel: "kimi-coding/k3:high", attemptedModels: ["kimi-coding/k3:high"], modelFamily: "kimi", providerDomain: "moonshot" }, issuedAt: new Date().toISOString(),
	};
	state.sessionId = "session";
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	receipt.lineageDigest = lineageDigestFor(receipt);
	await store.initialize(graph, state, receipt, digest);
	const authorization = JSON.parse(await readFile(store.path("authorization.json"), "utf8"));
	assert.equal(authorization.schemaVersion, 3);
	assert.equal(authorization.planningReceipt.consumedByRunId, graph.graphId);
	assert.equal(authorization.planningReceiptDigest, canonicalDigest(authorization.planningReceipt));
	const downgraded = structuredClone(authorization);
	downgraded.schemaVersion = 2;
	for (const field of ["planningReceipt", "planningReceiptDigest", "planningBindingDigest", "planningAdmissionId", "sourceGraphSpecDigest"]) delete downgraded[field];
	await writeFile(store.path("authorization.json"), JSON.stringify(downgraded));
	await assert.rejects(store.loadGraph(), /planning admission marker/);
	await assert.rejects(loadValidatedRun(store, 20), /planning admission marker/);
	await writeFile(store.path("authorization.json"), JSON.stringify(authorization));
	const forgedAttempts = structuredClone(authorization);
	forgedAttempts.planningReceipt.planner.attemptedModels = ["cheap/weak:low", "wisdomrouter/gpt-5.6-sol:high"];
	forgedAttempts.planningReceipt.lineageDigest = lineageDigestFor(forgedAttempts.planningReceipt);
	forgedAttempts.planningReceiptDigest = canonicalDigest(forgedAttempts.planningReceipt);
	forgedAttempts.planningBindingDigest = canonicalDigest({ graphDigest: forgedAttempts.graphDigest, planningReceiptDigest: forgedAttempts.planningReceiptDigest, runInstanceId: forgedAttempts.runInstanceId, sourceGraphSpecDigest: forgedAttempts.sourceGraphSpecDigest });
	await writeFile(store.path("authorization.json"), JSON.stringify(forgedAttempts));
	await assert.rejects(store.loadGraph(), /attempted-model provenance/);
	await writeFile(store.path("authorization.json"), JSON.stringify(authorization));
	const forgedPlanner = structuredClone(authorization);
	forgedPlanner.planningReceipt.planner = { decisionId: "forged", resolvedModel: "cheap/weak:low", attemptedModels: ["cheap/weak:low"], modelFamily: "cheap", providerDomain: "cheap" };
	forgedPlanner.planningReceipt.lineageDigest = lineageDigestFor(forgedPlanner.planningReceipt);
	forgedPlanner.planningReceiptDigest = canonicalDigest(forgedPlanner.planningReceipt);
	forgedPlanner.planningBindingDigest = canonicalDigest({
		graphDigest: forgedPlanner.graphDigest,
		planningReceiptDigest: forgedPlanner.planningReceiptDigest,
		runInstanceId: forgedPlanner.runInstanceId,
		sourceGraphSpecDigest: forgedPlanner.sourceGraphSpecDigest,
	});
	await writeFile(store.path("authorization.json"), JSON.stringify(forgedPlanner));
	await assert.rejects(store.loadGraph(), /mandatory strategic\/R1 model/);
	await writeFile(store.path("authorization.json"), JSON.stringify(authorization));
	authorization.planningReceipt.plannerOutputDigest = "b".repeat(64);
	await writeFile(store.path("authorization.json"), JSON.stringify(authorization));
	await assert.rejects(store.loadGraph(), /planning receipt digest/);
	await assert.rejects(loadValidatedRun(store, 20), /planning receipt digest/);
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
	assert.equal(graph.spawnBudget, 2);
	assert.equal((await loadValidatedRun(store, 1)).graph.graphId, graph.graphId);
});

test("persisted graph validation uses the sealed admission spawn budget", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-graph-sealed-budget-"));
	await writeFile(join(root, "target.md"), "before");
	const graph = graphAt(root, "sealed-budget");
	const store = new GraphStore(join(root, "runs"), graph.graphId);
	await store.initialize(graph, snapshot(graph, root));
	const persisted = JSON.parse(await readFile(store.path("graph.json"), "utf8"));
	persisted.spawnBudget = 0;
	await writeFile(store.path("graph.json"), JSON.stringify(persisted));
	await assert.rejects(loadValidatedRun(store, 20), /spawn budget|authorization graph digest|invalid graph authorization/i);
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
	assert.equal((await loadValidatedRun(store, 2)).snapshot.status, "needs_attention");
	const contractPath = store.path("nodes", "read", "attempt-1", "workspace", ".pi-graph", "node-contract.json");
	const contract = JSON.parse(await readFile(contractPath, "utf8"));
	contract.contextDigest = "f".repeat(64);
	await writeFile(contractPath, JSON.stringify(contract));
	await assert.rejects(loadValidatedRun(store, 2), /Workspace contract digest mismatch/);
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
	const workspace = await prepareWorkspace({ graphId: graph.graphId, node: graph.nodes[0]!, attempt: 1, attemptDir, strategy: "shadow", protectedSourceRoots: [runs] });
	const attemptNonce = randomUUID();
	const asyncId = `stop-${randomUUID()}`;
	const asyncDir = join(subagentAsyncRoot(), asyncId);
	await mkdir(asyncDir, { recursive: true });
	await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "running", sessionId: "session", sessionDir: join(attemptDir, "session", "child") }));
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
	const lineage = { runInstanceId: state.runInstanceId, graphId: graph.graphId, taskId: "read", attempt: 1, attemptNonce, sessionDir: join(attemptDir, "session"), ownerSessionId: "session" };
	await store.writeJson("nodes/read/attempt-1/child-dispatch.json", {
		schemaVersion: 1,
		dispatchKey: canonicalDigest({ lineage, requestDigest: "0".repeat(64) }),
		requestId: `pi-graph-v2-${canonicalDigest({ lineage, requestDigest: "0".repeat(64) }).slice(0, 40)}`,
		requestDigest: "0".repeat(64),
		lineage,
		phase: "bound",
		asyncId,
		asyncDir,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});
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
				await writeFile(join(asyncDir, "status.json"), JSON.stringify({ runId: asyncId, state: "stopped", sessionId: "session", sessionDir: join(attemptDir, "session", "child") }));
				bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, { success: true, data: { state: "stopping" } });
			})();
		},
	};
	const config: GraphConfig = { enabled: true, runsDir: runs, maxConcurrency: 1, readOnlyBurst: 1, maxSpawnBudget: 2, rpcTimeoutMs: 50, validationTimeoutMs: 1_000, notifyOnComplete: false, runtimeV2Dispatch: true };
	const terminal = await new GraphRunner(graph, state, store, bus, new LeaseRegistry(join(runs, ".control", "leases")), config).run();
	assert.equal(terminal.status, "stopped", JSON.stringify(terminal));
	assert.equal(stopCalls, 1);
	assert.equal((await store.readAttemptRecord("read", 1)).terminalStatus, "stopped");
	assert.equal((await loadValidatedRun(new GraphStore(runs, graph.graphId), 2)).snapshot.status, "stopped");
	await rm(asyncDir, { recursive: true, force: true });
});
