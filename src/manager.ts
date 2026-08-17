import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compileGraph } from "./compile.ts";
import { validateGraphId } from "./compile.ts";
import { loadGraphConfig } from "./config.ts";
import { LeaseRegistry } from "./leases.ts";
import { GraphRunner, initialSnapshot } from "./runner.ts";
import { GraphAlreadySupervisedError, GraphStore } from "./store.ts";
import { recoverRunBySessionDir, SubagentRpcClient } from "./rpc.ts";
import { readAsyncRunState, requestAsyncStop, waitForConfirmedStop } from "./lifecycle.ts";
import type { CompiledNode, GraphConfig, GraphSnapshot, GraphSpec, NodeRuntimeState } from "./types.ts";
import { loadOrRebuildValidatedRun, loadValidatedRun, recordProtectedIncident } from "./reconciler.ts";
import { prepareAttentionResume, runRetentionMaintenance, type RetentionReport } from "./retention.ts";
import { ChildRuntime, type ChildLineage } from "./child-runtime.ts";
import { graphSpecDigest, type LegacyPlanningReceipt } from "./authorization.ts";

interface RunningGraph {
	runner: GraphRunner;
	promise: Promise<GraphSnapshot>;
}

interface BackgroundEntry {
	generation: number;
	promise: Promise<unknown>;
	abort: AbortController;
}

export interface GraphManagerOptions {
}

function graphSummary(snapshot: GraphSnapshot, runsDir = "~/.pi/agent/graph-runs"): string {
	const counts = Object.values(snapshot.nodes).reduce<Record<string, number>>((acc, node) => {
		acc[node.status] = (acc[node.status] ?? 0) + 1;
		return acc;
	}, {});
	return [
		`Graph: ${snapshot.graphId}`,
		`Status: ${snapshot.status}`,
		`Goal: ${snapshot.goal}`,
		`Nodes: ${Object.entries(counts).map(([status, count]) => `${status}=${count}`).join(", ")}`,
		`State: ${join(runsDir, snapshot.graphId, "snapshot.json")}`,
		...(snapshot.error ? [`Error: ${snapshot.error}`] : []),
	].join("\n");
}

async function waitForGraphTerminal(store: GraphStore, timeoutMs: number): Promise<GraphSnapshot> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const snapshot = await store.loadSnapshot();
		if (!["queued", "running"].includes(snapshot.status)) return snapshot;
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
	}
	throw new Error("Graph stop was requested from its active Supervisor, but terminal confirmation timed out. Inspect graph status before retrying.");
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const output = new Array<R>(items.length);
	let cursor = 0;
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (cursor < items.length) {
			const index = cursor;
			cursor += 1;
			output[index] = await worker(items[index]!);
		}
	}));
	return output;
}

export function sessionIdentity(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionId() ?? ctx.sessionManager.getSessionFile() ?? undefined;
}

export function legacySessionIdentity(ctx: ExtensionContext): string | undefined {
	return ctx.sessionManager.getSessionFile() ?? undefined;
}

function ownerSessionFile(ctx?: ExtensionContext): string | undefined {
	const path = ctx?.sessionManager.getSessionFile();
	return path ? resolve(path) : undefined;
}

function orchestratorIntercomTarget(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	const getSessionName = (pi as ExtensionAPI & { getSessionName?: () => string | undefined }).getSessionName;
	if (typeof getSessionName !== "function") return undefined;
	const named = getSessionName.call(pi)?.trim();
	if (named) return named;
	const inherited = process.env.PI_INTERCOM_SESSION_ID?.trim();
	const sessionId = (inherited || ctx.sessionManager.getSessionId()).replace(/^session-/u, "");
	return `subagent-chat-${sessionId.slice(0, 8)}`;
}

export function assertRoutingReevaluationPreDispatch(attempt: NodeRuntimeState["attempts"][number] | undefined, providerDispatch = attempt?.providerDispatches?.at(-1)): void {
	if (!attempt || attempt.asyncId !== undefined || attempt.asyncDir !== undefined || attempt.writesCommittedAt !== undefined || providerDispatch?.requestDigest !== undefined || providerDispatch?.asyncId !== undefined || providerDispatch?.asyncDir !== undefined) {
		throw new Error("Routing cannot be re-evaluated because the blocked attempt may already have dispatched or committed writes.");
	}
}

function ownsSnapshot(ctx: ExtensionContext, snapshot: GraphSnapshot): boolean {
	if (!snapshot.sessionId) return true;
	return [ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId()].filter(Boolean).includes(snapshot.sessionId);
}

async function recoverSnapshotRun(snapshot: GraphSnapshot, sessionDir: string, ownerSessionFileIdentity?: string): Promise<{ asyncId: string; asyncDir: string } | null> {
	if (snapshot.schemaVersion === 2 && !snapshot.sessionId) return null;
	return recoverRunBySessionDir(sessionDir, undefined, snapshot.sessionId, snapshot.schemaVersion === 2 ? ownerSessionFileIdentity : undefined);
}

function childLineages(snapshot: Extract<GraphSnapshot, { schemaVersion: 2 }>): ChildLineage[] {
	return Object.values(snapshot.nodes).flatMap((state) => state.attempts.flatMap((attempt) => {
		if (!attempt.attemptNonce) return [];
		const dispatches = attempt.providerDispatches?.length
			? attempt.providerDispatches
			: [{ dispatch: 1, sessionDir: attempt.sessionDir }];
		return dispatches.map((dispatch) => ({
			runInstanceId: snapshot.runInstanceId,
			graphId: snapshot.graphId,
			taskId: state.taskId,
			attempt: attempt.attempt,
			attemptNonce: attempt.attemptNonce!,
			sessionDir: dispatch.sessionDir,
			...(dispatch.dispatch > 1 ? { providerDispatch: dispatch.dispatch } : {}),
			...(snapshot.sessionId ? { ownerSessionId: snapshot.sessionId } : {}),
		}));
	}));
}

export async function loadValidatedGraph(store: GraphStore, snapshot: GraphSnapshot, maxSpawnBudget: number, allowProviderWorkspaceResetRecovery = false) {
	const validated = await loadValidatedRun(store, maxSpawnBudget, { allowProviderWorkspaceResetRecovery });
	if (validated.snapshot.graphId !== snapshot.graphId || validated.snapshot.updatedAt !== snapshot.updatedAt) throw new Error("Graph snapshot changed during trusted loading.");
	return validated.graph;
}

export class GraphManager {
	private readonly pi: ExtensionAPI;
	private config?: GraphConfig;
	private context?: ExtensionContext;
	private readonly runners = new Map<string, RunningGraph>();
	private lifecycleGeneration = 0;
	private maintenance?: { generation: number; promise: Promise<RetentionReport> };
	private readonly background = new Set<BackgroundEntry>();
	private readonly recoveryChildRuntimes = new Map<number, ChildRuntime>();
	private readonly retiredReaperRunners = new Map<number, Set<GraphRunner>>();
	private readonly options: GraphManagerOptions;
	private allowUnplannedStartForTests = false;
	private lifecycleClosing = false;

	constructor(pi: ExtensionAPI, options: GraphManagerOptions = {}) {
		this.pi = pi;
		this.options = options;
	}

	private isCurrent(generation: number, ctx: ExtensionContext): boolean {
		return generation === this.lifecycleGeneration && this.context === ctx;
	}

	private trackBackground<T>(generation: number, abort: AbortController, operation: Promise<T>): Promise<T> {
		const entry: BackgroundEntry = { generation, abort, promise: operation };
		this.background.add(entry);
		void operation.finally(() => this.background.delete(entry)).catch(() => undefined);
		return operation;
	}

	private runBackground<T>(generation: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const abort = new AbortController();
		return this.trackBackground(generation, abort, Promise.resolve().then(() => operation(abort.signal)));
	}

	private async drainBackground(maxGeneration: number): Promise<void> {
		while (true) {
			const target = [...this.background].filter((entry) => entry.generation <= maxGeneration);
			if (target.length === 0) return;
			for (const entry of target) entry.abort.abort("session shutdown");
			await Promise.allSettled(target.map((entry) => entry.promise));
		}
	}

	private recoveryChildRuntime(generation: number, config: GraphConfig, ctx: ExtensionContext): ChildRuntime {
		const current = this.recoveryChildRuntimes.get(generation);
		if (current) return current;
		const runtime = new ChildRuntime(new SubagentRpcClient(this.pi.events, config.rpcTimeoutMs), 2_000, 24 * 60 * 60_000, 20, 250, 30_000, ownerSessionFile(ctx));
		this.recoveryChildRuntimes.set(generation, runtime);
		return runtime;
	}

	private disposeRecoveryChildRuntimes(maxGeneration: number): void {
		for (const [generation, runtime] of this.recoveryChildRuntimes) {
			if (generation > maxGeneration) continue;
			runtime.dispose();
			this.recoveryChildRuntimes.delete(generation);
		}
	}

	private retireRunnerReapers(generation: number, runner: GraphRunner): void {
		if (!runner.dispose({ preserveReapers: true })) return;
		const retained = this.retiredReaperRunners.get(generation) ?? new Set<GraphRunner>();
		retained.add(runner);
		this.retiredReaperRunners.set(generation, retained);
	}

	private disposeRetiredReaperRunners(maxGeneration: number): void {
		for (const [generation, runners] of this.retiredReaperRunners) {
			if (generation > maxGeneration) continue;
			for (const runner of runners) runner.dispose();
			this.retiredReaperRunners.delete(generation);
		}
	}

	async initialize(ctx: ExtensionContext): Promise<void> {
		this.lifecycleClosing = false;
		const generation = ++this.lifecycleGeneration;
		this.context = ctx;
		return this.runBackground(generation, (signal) => this.initializeGeneration(ctx, generation, signal));
	}

	private async initializeGeneration(ctx: ExtensionContext, generation: number, signal: AbortSignal): Promise<void> {
		const config = await loadGraphConfig();
		if (!this.isCurrent(generation, ctx) || signal.aborted) return;
		this.config = config;
		await mkdir(config.runsDir, { recursive: true });
		if (!this.isCurrent(generation, ctx) || signal.aborted) return;
		if (!config.enabled) return;
		const owner = sessionIdentity(ctx);
		const legacyOwner = legacySessionIdentity(ctx);
		const discovered = await GraphStore.discover(config.runsDir);
		const candidates = await mapWithConcurrency(discovered, 32, async (graphId) => {
			const store = new GraphStore(config.runsDir, graphId);
			try {
				return { graphId, store, inspected: await store.loadSnapshot() };
			} catch {
				return { graphId, store, inspected: undefined };
			}
		});
		const terminal: Array<{ graphId: string; store: GraphStore; snapshot: GraphSnapshot }> = [];
		for (const { graphId, store, inspected } of candidates) {
			if (!this.isCurrent(generation, ctx) || signal.aborted) return;
			if (this.runners.has(graphId)) continue;
			if (inspected && ((inspected.sessionId !== owner && inspected.sessionId !== legacyOwner) || !["queued", "running"].includes(inspected.status))) {
				if (inspected.schemaVersion === 2 && !["queued", "running"].includes(inspected.status)) {
					terminal.push({ graphId, store, snapshot: inspected });
				}
				continue;
			}
			if (inspected) await this.adoptGraph(graphId, store, owner, legacyOwner, config, ctx, generation, signal);
			else void this.runBackground(generation, (childSignal) => this.adoptGraph(graphId, store, owner, legacyOwner, config, ctx, generation, childSignal)).catch((error) => {
				if (this.isCurrent(generation, ctx)) ctx.ui.notify(`pi-graph background recovery failed '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		}
		void this.runBackground(generation, (childSignal) => mapWithConcurrency(terminal, 4, async ({ graphId, store, snapshot }) => {
			try {
				await this.enforceTerminalTombstones(store, snapshot, config, ctx, generation, childSignal);
			} catch (error) {
				if (this.isCurrent(generation, ctx) && !childSignal.aborted) ctx.ui.notify(`pi-graph terminal tombstone recovery skipped '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		})).catch(() => undefined);
		void this.maintain(config, ctx, generation).catch(() => undefined);
	}

	private async adoptGraph(
		graphId: string,
		store: GraphStore,
		owner: string | undefined,
		legacyOwner: string | undefined,
		config: GraphConfig,
		ctx: ExtensionContext,
		generation: number,
		signal: AbortSignal = new AbortController().signal,
	): Promise<void> {
		let releaseSupervisor: (() => Promise<void>) | undefined;
		try {
			if (!this.isCurrent(generation, ctx) || signal.aborted || this.runners.has(graphId)) return;
			try {
				const inspected = await store.loadSnapshot();
				if ((inspected.sessionId !== owner && inspected.sessionId !== legacyOwner) || !["queued", "running"].includes(inspected.status)) return;
			} catch {
				try {
					const authorization = await store.loadAuthorization();
					if (authorization.sessionId !== owner && authorization.sessionId !== legacyOwner) return;
				} catch {
					// Legacy or damaged projections have no trusted pre-claim identity.
				}
			}
			releaseSupervisor = await store.acquireSupervisor(randomUUID());
			const validated = await loadOrRebuildValidatedRun(store, config.maxSpawnBudget, { allowProviderWorkspaceResetRecovery: true });
			const snapshot = validated.snapshot;
			if (snapshot.schemaVersion === 2) {
				const childRuntime = this.recoveryChildRuntime(generation, config, ctx);
				for (const lineage of childLineages(snapshot)) {
					const enforced = await childRuntime.enforceTombstone(lineage, signal);
					if (enforced?.stopped && this.isCurrent(generation, ctx) && !signal.aborted) ctx.ui.notify(`pi-graph stopped a late child for '${graphId}/${lineage.taskId}' during recovery.`, "warning");
				}
			}
			if ((snapshot.sessionId !== owner && snapshot.sessionId !== legacyOwner) || !["queued", "running"].includes(snapshot.status)) return;
			if (!this.isCurrent(generation, ctx) || signal.aborted || this.runners.has(graphId)) return;
			snapshot.sessionId = owner;
			snapshot.supervisorEpoch = randomUUID();
			await store.saveSnapshot(snapshot);
			if (!this.isCurrent(generation, ctx) || signal.aborted) return;
			const routingConfig = undefined;
			if (!this.isCurrent(generation, ctx) || signal.aborted) return;
			this.launch(validated.graph, snapshot, store, releaseSupervisor, routingConfig, generation, ctx);
			releaseSupervisor = undefined;
		} catch (error) {
			if (!(error instanceof GraphAlreadySupervisedError) && this.isCurrent(generation, ctx) && !signal.aborted) {
				await recordProtectedIncident(store, error).catch(() => undefined);
				if (this.isCurrent(generation, ctx)) ctx.ui.notify(`pi-graph recovery skipped '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			await releaseSupervisor?.();
		}
	}

	private async enforceTerminalTombstones(store: GraphStore, snapshot: GraphSnapshot, config: GraphConfig, ctx: ExtensionContext, generation: number, signal: AbortSignal): Promise<void> {
		if (snapshot.schemaVersion !== 2) return;
		let hasTombstone = false;
		for (const lineage of childLineages(snapshot)) {
			try {
				await access(join(dirname(lineage.sessionDir), "child-tombstone.json"));
				hasTombstone = true;
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (!hasTombstone) return;
		if (!this.isCurrent(generation, ctx) || signal.aborted) return;
		const validated = await loadValidatedRun(store, config.maxSpawnBudget);
		if (validated.snapshot.schemaVersion !== 2) return;
		const childRuntime = this.recoveryChildRuntime(generation, config, ctx);
		for (const lineage of childLineages(validated.snapshot)) {
			const enforced = await childRuntime.enforceTombstone(lineage, signal);
			if (enforced?.stopped && this.isCurrent(generation, ctx) && !signal.aborted) ctx.ui.notify(`pi-graph stopped a late child for '${snapshot.graphId}/${lineage.taskId}' during terminal recovery.`, "warning");
		}
	}

	private async maintain(config: GraphConfig, ctx: ExtensionContext | undefined, generation = this.lifecycleGeneration): Promise<RetentionReport> {
		if (this.maintenance?.generation === generation) return this.maintenance.promise;
		const promise = this.runBackground(generation, async (signal) => runRetentionMaintenance(config)
			.then((report) => {
				if (report.overSoftLimit && ctx && this.isCurrent(generation, ctx) && !signal.aborted) ctx.ui.notify("pi-graph storage is over its soft limit. Use /graphs storage to inspect protected data and enable autoPrune only after review.", "warning");
				return report;
			})
			.catch((error) => {
				if (ctx && this.isCurrent(generation, ctx) && !signal.aborted) ctx.ui.notify(`pi-graph retention maintenance failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
				throw error;
			}));
		this.maintenance = { generation, promise };
		return promise.finally(() => { if (this.maintenance?.promise === promise) this.maintenance = undefined; });
	}

	async runMaintenance(): Promise<RetentionReport> {
		const { config } = this.requireReady();
		return this.maintain(config, this.context);
	}

	private requireReady(): { config: GraphConfig; context: ExtensionContext } {
		if (this.lifecycleClosing) throw new Error("pi-graph session shutdown is in progress.");
		if (!this.config || !this.context) throw new Error("pi-graph has no active Pi session.");
		if (!this.config.enabled) throw new Error("pi-graph is disabled in settings.json.");
		return { config: this.config, context: this.context };
	}

	private launch(graph: ReturnType<typeof compileGraph>, snapshot: GraphSnapshot, store: GraphStore, releaseSupervisor?: () => Promise<void>, routingConfig?: undefined, generation = this.lifecycleGeneration, ctx = this.context): void {
		if (!ctx || !this.isCurrent(generation, ctx) || this.runners.has(graph.graphId)) {
			void releaseSupervisor?.();
			return;
		}
		const config = this.config;
		if (!config) { void releaseSupervisor?.(); return; }
		const leases = new LeaseRegistry(join(config.runsDir, ".control", "leases"));
		const runner = new GraphRunner(graph, snapshot, store, this.pi.events, leases, config, (terminal) => {
			if (!this.isCurrent(generation, ctx)) return;
			const activeSessionId = sessionIdentity(ctx);
			if (config.notifyOnComplete && activeSessionId === terminal.sessionId && terminal.status !== "stopped") {
				this.pi.sendMessage({
					customType: "pi-graph-result",
					content: `[pi-graph ${terminal.status}]\nThis is a new triggered LLM turn. First call assess_task exactly once for this complete result message; do not reuse any earlier turn admission.\n${graphSummary(terminal, config.runsDir)}\nInspect rejected or blocked nodes before claiming the overall goal is complete.`,
					display: true,
					details: terminal,
				}, { triggerTurn: true, deliverAs: "followUp" });
			} else if (activeSessionId === terminal.sessionId && terminal.status === "stopped") {
				ctx.ui.notify(`pi-graph '${graph.graphId}' stopped.`, "info");
			}
			void this.maintain(config, ctx, generation).catch(() => undefined);
		}, ownerSessionFile(ctx), orchestratorIntercomTarget(this.pi, ctx));
		const promise = runner.run(releaseSupervisor).catch(async (error) => {
			if (error instanceof GraphAlreadySupervisedError) {
				if (this.isCurrent(generation, ctx)) ctx.ui.notify(`pi-graph '${graph.graphId}' is already supervised by another active Pi process.`, "warning");
				return snapshot;
			}
			if (!this.isCurrent(generation, ctx)) return snapshot;
			let authoritative = await store.loadSnapshot().catch(() => undefined);
			if (authoritative && ["queued", "running"].includes(authoritative.status)) {
				const recoveryStore = new GraphStore(config.runsDir, graph.graphId);
				let releaseRecovery: (() => Promise<void>) | undefined;
				try {
					releaseRecovery = await recoveryStore.acquireSupervisor(`runtime-failure-${randomUUID()}`);
					authoritative = await recoveryStore.loadSnapshot();
					if (["queued", "running"].includes(authoritative.status)) {
						authoritative.status = "needs_attention";
						authoritative.error = error instanceof Error ? error.message : String(error);
						await recoveryStore.saveSnapshot(authoritative);
						await recoveryStore.event("graph.runtime_failed_recovered", { error: authoritative.error });
					}
				} catch (recoveryError) {
					if (!(recoveryError instanceof GraphAlreadySupervisedError)) {
						if (this.isCurrent(generation, ctx)) ctx.ui.notify(`pi-graph could not persist failure recovery for '${graph.graphId}': ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "warning");
					}
				} finally {
					await releaseRecovery?.();
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			if (this.isCurrent(generation, ctx)) ctx.ui.notify(`pi-graph '${graph.graphId}' stopped: ${message}`, "error");
			return authoritative ?? snapshot;
		}).finally(() => {
			this.retireRunnerReapers(generation, runner);
			const current = this.runners.get(graph.graphId);
			if (current?.runner === runner) this.runners.delete(graph.graphId);
		});
		this.runners.set(graph.graphId, { runner, promise });
	}

	async start(spec: GraphSpec, planningReceipt?: LegacyPlanningReceipt): Promise<GraphSnapshot> {
		const { config, context } = this.requireReady();
		const generation = this.lifecycleGeneration;
		return this.runBackground(generation, (signal) => this.startGeneration(spec, planningReceipt, config, context, generation, signal));
	}

	private async startGeneration(spec: GraphSpec, planningReceipt: LegacyPlanningReceipt | undefined, config: GraphConfig, context: ExtensionContext, generation: number, signal: AbortSignal): Promise<GraphSnapshot> {
		if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before Graph start began.");
		if (!planningReceipt && !this.allowUnplannedStartForTests) throw new Error("GraphManager.start requires a reviewed planning receipt. Unplanned Runtime v2 admission is disabled.");
		const graph = compileGraph(spec, context.cwd, config.maxSpawnBudget, 2, [config.runsDir]);
		if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed during Graph start admission.");
		const store = new GraphStore(config.runsDir, graph.graphId);
		const snapshot = initialSnapshot(graph, context.cwd, sessionIdentity(context), 2);
		await store.initialize(graph, snapshot, planningReceipt, planningReceipt ? graphSpecDigest(spec) : undefined);
		if (!this.isCurrent(generation, context) || signal.aborted) {
			await this.finalizeUnlaunchedStart(store, snapshot);
			throw new Error("Pi session changed while Graph start was persisted; the run was durably stopped before launch.");
		}
		const releaseSupervisor = await store.acquireSupervisor(snapshot.supervisorEpoch);
		try {
			const authoritative = await store.loadSnapshot();
			if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before Graph execution launch.");
			this.launch(graph, authoritative, store, releaseSupervisor, undefined, generation, context);
			return authoritative;
		} catch (error) {
			await releaseSupervisor();
			throw error;
		}
	}

	private async finalizeUnlaunchedStart(store: GraphStore, admitted: GraphSnapshot): Promise<void> {
		await store.recordDesiredState("stopped");
		let releaseSupervisor: (() => Promise<void>) | undefined;
		try {
			releaseSupervisor = await store.acquireSupervisor(`cancel-unlaunched-${randomUUID()}`);
			const snapshot = await store.loadSnapshot();
			if (snapshot.schemaVersion !== 2 || admitted.schemaVersion !== 2 || snapshot.runInstanceId !== admitted.runInstanceId || snapshot.status !== "queued") return;
			for (const state of Object.values(snapshot.nodes)) {
				if (state.status === "pending" || state.status === "ready") state.status = "stopped";
			}
			snapshot.status = "stopped";
			snapshot.error = "Graph start was cancelled because its Pi lifecycle generation closed before launch.";
			await store.saveSnapshot(snapshot);
		} finally {
			await releaseSupervisor?.();
		}
	}

	async status(graphId: string): Promise<GraphSnapshot> {
		const { config } = this.requireReady();
		return new GraphStore(config.runsDir, validateGraphId(graphId)).loadSnapshot();
	}

	async list(): Promise<GraphSnapshot[]> {
		const report = await this.listReport();
		if (report.protected.length) throw new Error(`Protected graph run(s): ${report.protected.map((entry) => `${entry.graphId}: ${entry.reason}`).join("; ")}`);
		return report.snapshots;
	}

	async listReport(): Promise<{ snapshots: GraphSnapshot[]; protected: Array<{ graphId: string; reason: string }> }> {
		const { config } = this.requireReady();
		const snapshots: GraphSnapshot[] = [];
		const protectedRuns: Array<{ graphId: string; reason: string }> = [];
		for (const graphId of await GraphStore.discover(config.runsDir)) {
			try {
				snapshots.push(await new GraphStore(config.runsDir, graphId).loadSnapshot());
			} catch (error) {
				protectedRuns.push({ graphId, reason: error instanceof Error ? error.message : String(error) });
			}
		}
		return { snapshots: snapshots.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), protected: protectedRuns.sort((a, b) => a.graphId.localeCompare(b.graphId)) };
	}

	async stop(graphId: string): Promise<GraphSnapshot> {
		const { config, context } = this.requireReady();
		const generation = this.lifecycleGeneration;
		return this.runBackground(generation, (signal) => this.stopGeneration(graphId, config, context, generation, signal));
	}

	private async stopGeneration(graphId: string, config: GraphConfig, context: ExtensionContext, generation: number, signal: AbortSignal): Promise<GraphSnapshot> {
		if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before Graph stop began.");
		validateGraphId(graphId);
		const active = this.runners.get(graphId);
		const store = new GraphStore(config.runsDir, graphId);
		if (active) {
			if (!ownsSnapshot(context, active.runner.snapshot)) throw new Error("Only the session that owns this graph may stop it.");
			active.runner.beginStop();
			try {
				await store.recordDesiredState("stopped");
			} finally {
				active.runner.stop();
			}
			const result = await active.promise;
			if (!["queued", "running"].includes(result.status)) return result;
		}
		let snapshot = await store.loadSnapshot();
		if (!ownsSnapshot(context, snapshot)) throw new Error("Only the session that owns this graph may stop it.");
		if (["complete", "failed", "blocked", "stopped"].includes(snapshot.status)) return snapshot;
		let releaseSupervisor: (() => Promise<void>) | undefined;
		try {
			releaseSupervisor = await store.acquireSupervisor(randomUUID());
		} catch (error) {
			if (!(error instanceof GraphAlreadySupervisedError)) throw error;
			await store.requestControl("stop");
			return waitForGraphTerminal(store, 35_000);
		}
		try {
			await store.recordDesiredState("stopped");
			snapshot = await store.loadSnapshot();
				if (!ownsSnapshot(context, snapshot)) throw new Error("Graph ownership changed while acquiring its Supervisor claim.");
				if (["complete", "failed", "blocked", "stopped"].includes(snapshot.status)) return snapshot;
				if (snapshot.schemaVersion === 2) {
					await loadValidatedRun(store, config.maxSpawnBudget, { allowProviderWorkspaceResetRecovery: true });
					for (const state of Object.values(snapshot.nodes)) {
						const attempt = state.attempts.at(-1);
						if (!attempt) continue;
						const authority = await store.readAttemptRecord(state.taskId, attempt.attempt);
						if (authority.phase !== "accepted") continue;
						state.status = "accepted";
						state.error = undefined;
						attempt.status = "accepted";
						attempt.endedAt ??= authority.updatedAt;
						attempt.manifestPath ??= store.path("nodes", state.taskId, `attempt-${attempt.attempt}`, "result-manifest.json");
					}
				}
			if (["queued", "running"].includes(snapshot.status)) {
				const graph = await loadValidatedGraph(store, snapshot, config.maxSpawnBudget, true);
				const routingConfig = undefined;
				if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before durable Graph stop recovery launched.");
				const runner = new GraphRunner(graph, snapshot, store, this.pi.events, new LeaseRegistry(join(config.runsDir, ".control", "leases")), config, undefined, ownerSessionFile(context), orchestratorIntercomTarget(this.pi, context));
				const claimed = releaseSupervisor;
				releaseSupervisor = undefined;
				const promise = runner.run(claimed).finally(() => {
					this.retireRunnerReapers(generation, runner);
					const current = this.runners.get(graphId);
					if (current?.runner === runner) this.runners.delete(graphId);
				});
				this.runners.set(graphId, { runner, promise });
				return promise;
			}
			let uncertainStop = Object.values(snapshot.nodes).some((state) => state.status === "stale");
			const rpc = new SubagentRpcClient(this.pi.events, config.rpcTimeoutMs);
			const childRuntime = this.recoveryChildRuntime(generation, config, context);
			const stoppedGraph = await loadValidatedGraph(store, snapshot, config.maxSpawnBudget, true);
				for (const state of Object.values(snapshot.nodes)) {
					if (["accepted", "failed", "blocked", "stopped"].includes(state.status)) continue;
					const attempt = state.attempts.at(-1);
				if (attempt && ["collecting", "verifying"].includes(state.status)) {
					try {
						const applyStatus = await store.readApplyPlanStatus(state.taskId, attempt.attempt);
						if (applyStatus === "applying" || applyStatus === "committed") {
							uncertainStop = true;
							state.status = "stale";
							attempt.status = "stale";
							state.error = applyStatus === "committed"
								? "Source commit completed before offline stop; resume to finalize the same attempt."
								: "Source apply was interrupted before offline stop; resume to recover the transaction before deciding whether to retry.";
							if (applyStatus === "committed") attempt.writesCommittedAt ??= new Date().toISOString();
							continue;
						}
					} catch (error) {
						uncertainStop = true;
						state.status = "stale";
						attempt.status = "stale";
						state.error = `Apply transaction state could not be verified: ${error instanceof Error ? error.message : String(error)}`;
						continue;
					}
				}
					const childMayBeActive = attempt
						&& ["running", "dispatching", "dispatch_unknown", "waiting_input", "resource_wait"].includes(attempt.status)
						&& ["running", "dispatching", "dispatch_unknown", "waiting_input", "resource_wait", "stale"].includes(state.status);
					if (childMayBeActive) {
					const providerDispatch = attempt?.providerDispatches?.at(-1);
					let preparedWithoutDispatch = false;
					if (snapshot.schemaVersion === 2 && attempt?.attemptNonce) {
						const authority = await store.readAttemptRecord(state.taskId, attempt.attempt);
						preparedWithoutDispatch = authority.phase === "prepared"
							&& authority.requestDigest === undefined
							&& authority.asyncId === undefined
							&& (!providerDispatch || (providerDispatch.status === "prepared" && providerDispatch.requestDigest === undefined && providerDispatch.asyncId === undefined));
					}
					if (preparedWithoutDispatch) {
						state.status = "stopped";
						attempt.status = "stopped";
						continue;
					}
					let identity = providerDispatch?.asyncId && providerDispatch.asyncDir
						? { asyncId: providerDispatch.asyncId, asyncDir: providerDispatch.asyncDir }
						: attempt?.asyncId && attempt.asyncDir ? { asyncId: attempt.asyncId, asyncDir: attempt.asyncDir } : null;
					const activeSessionDir = providerDispatch?.sessionDir ?? attempt?.sessionDir;
					if (!identity && activeSessionDir) {
						try {
							identity = await recoverSnapshotRun(snapshot, activeSessionDir, ownerSessionFile(context));
						} catch (error) {
							uncertainStop = true;
							state.status = "stale";
							if (attempt) attempt.status = "stale";
							state.error = `Stop identity is ambiguous: ${error instanceof Error ? error.message : String(error)}`;
							continue;
						}
					}
					if (!identity) {
						uncertainStop = true;
						if (snapshot.schemaVersion === 2 && attempt?.attemptNonce) {
							const lineage: ChildLineage = {
								runInstanceId: snapshot.runInstanceId,
								graphId: snapshot.graphId,
								taskId: state.taskId,
								attempt: attempt.attempt,
								attemptNonce: attempt.attemptNonce,
								sessionDir: activeSessionDir!,
								...(providerDispatch && providerDispatch.dispatch > 1 ? { providerDispatch: providerDispatch.dispatch } : {}),
								...(snapshot.sessionId ? { ownerSessionId: snapshot.sessionId } : {}),
							};
							await childRuntime.abandonKnown(lineage, "offline graph stop could not locate a child identity").catch(() => null);
						}
						state.status = "stale";
						if (attempt) attempt.status = "stale";
						state.error = "Stop could not locate the child process; inspect external side effects before continuing.";
						continue;
					}
					try {
						let confirmed = false;
						const childState = await readAsyncRunState(identity.asyncId, identity.asyncDir);
						if (["stopped", "failed"].includes(childState ?? "")) confirmed = true;
						if (childState === "complete") {
							const node = stoppedGraph.nodes.find((candidate) => candidate.taskId === state.taskId)!;
							if (node.sideEffect === "external_write" || node.allowBash) throw new Error("child completed with ambient or external write authority before stop; reconcile its side effects");
							confirmed = true;
						}
						if (!confirmed && snapshot.schemaVersion === 2 && attempt?.attemptNonce && activeSessionDir) {
							const authority = await store.readAttemptRecord(state.taskId, attempt.attempt);
							try {
								await rpc.call("stop", { id: identity.asyncId });
							} catch {
								await requestAsyncStop(identity.asyncDir);
							}
							const lineage: ChildLineage = {
								runInstanceId: snapshot.runInstanceId,
								graphId: snapshot.graphId,
								taskId: state.taskId,
								attempt: attempt.attempt,
								attemptNonce: attempt.attemptNonce,
								sessionDir: activeSessionDir,
								...(providerDispatch && providerDispatch.dispatch > 1 ? { providerDispatch: providerDispatch.dispatch } : {}),
								...(snapshot.sessionId ? { ownerSessionId: snapshot.sessionId } : {}),
							};
							const abandoned = await childRuntime.abandonKnown(lineage, "offline graph stop requires durable child termination").catch(() => null)
								?? (providerDispatch?.requestDigest ?? authority.requestDigest
									? await childRuntime.abandonAuthorized(lineage, providerDispatch?.requestDigest ?? authority.requestDigest!, "offline graph stop requires durable child termination")
									: await childRuntime.abandonRecovered(lineage, "offline graph stop requires durable child termination"));
							if (abandoned) confirmed = abandoned.stopped || await waitForConfirmedStop(identity.asyncDir, 30_000);
							else {
								try {
									await rpc.call("stop", { id: identity.asyncId });
								} catch {
									await requestAsyncStop(identity.asyncDir);
								}
								confirmed = await waitForConfirmedStop(identity.asyncDir, 30_000);
							}
						} else if (!confirmed) {
							try {
								await rpc.call("stop", { id: identity.asyncId });
							} catch {
								await requestAsyncStop(identity.asyncDir);
							}
							confirmed = await waitForConfirmedStop(identity.asyncDir, 30_000);
						}
						if (!confirmed) throw new Error("child did not reach the stopped state; durable tombstone enforcement remains active");
					} catch (error) {
						uncertainStop = true;
						state.status = "stale";
						if (attempt) attempt.status = "stale";
						state.error = `Stop could not be confirmed: ${error instanceof Error ? error.message : String(error)}`;
						continue;
					}
				}
					if (!state.status || !["accepted", "failed", "blocked", "stale"].includes(state.status)) {
						state.status = "stopped";
						if (attempt) attempt.status = "stopped";
					}
				}
				if (snapshot.schemaVersion === 2) {
					for (const state of Object.values(snapshot.nodes)) {
						const attempt = state.attempts.at(-1);
						if (!attempt) continue;
						const authority = await store.readAttemptRecord(state.taskId, attempt.attempt);
						if (authority.phase === "accepted") {
							state.status = "accepted";
							attempt.status = "accepted";
							state.error = undefined;
							continue;
						}
						if (authority.phase === "terminal" && authority.terminalStatus) {
							state.status = authority.terminalStatus;
							attempt.status = authority.terminalStatus;
							state.error = authority.terminalError;
							if (authority.terminalStatus === "stale") uncertainStop = true;
							continue;
						}
						if (!["stale", "stopped"].includes(state.status)) continue;
						await store.writeAttemptRecord(state.taskId, attempt.attempt, {
							...authority,
							phase: "terminal",
							terminalStatus: state.status as "stale" | "stopped",
							...(state.error ? { terminalError: state.error } : {}),
							updatedAt: new Date().toISOString(),
						});
					}
				}
				snapshot.status = uncertainStop
					? "needs_attention"
					: Object.values(snapshot.nodes).every((state) => state.status === "accepted")
						? "complete"
						: "stopped";
			await store.saveSnapshot(snapshot);
			return snapshot;
		} finally {
			await releaseSupervisor?.();
		}
	}

	async suspendAll(): Promise<void> {
		this.lifecycleClosing = true;
		const closingGeneration = this.lifecycleGeneration;
		const generation = ++this.lifecycleGeneration;
		const context = this.context;
		const active = [...this.runners.values()];
		for (const entry of active) entry.runner.suspend();
		await Promise.allSettled(active.map((entry) => entry.promise));
		await this.drainBackground(closingGeneration);
		this.disposeRecoveryChildRuntimes(closingGeneration);
		this.disposeRetiredReaperRunners(closingGeneration);
		if (generation === this.lifecycleGeneration && this.context === context) this.context = undefined;
	}

	listActiveWork(): Array<{ id: string; sessionId: string }> {
		return [...this.runners.entries()].flatMap(([id, entry]) => entry.runner.snapshot.sessionId ? [{ id, sessionId: entry.runner.snapshot.sessionId }] : []);
	}

	async resume(graphId: string): Promise<GraphSnapshot> {
		const { config, context } = this.requireReady();
		const generation = this.lifecycleGeneration;
		return this.runBackground(generation, (signal) => this.resumeGeneration(graphId, config, context, generation, signal));
	}

	private async resumeGeneration(graphId: string, config: GraphConfig, context: ExtensionContext, generation: number, signal: AbortSignal): Promise<GraphSnapshot> {
		if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before Graph resume began.");
		validateGraphId(graphId);
		if (this.runners.has(graphId)) return this.status(graphId);
		const store = new GraphStore(config.runsDir, graphId);
		const releaseSupervisor = await store.acquireSupervisor(randomUUID());
		try {
			if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed while acquiring Graph resume authority.");
			const snapshot = await store.loadSnapshot();
			if (["complete", "failed", "blocked", "stopped"].includes(snapshot.status) || await store.readDesiredState() === "stopped") {
				throw new Error(`Graph status '${snapshot.status}' is final and cannot be resumed; start a new graph run.`);
			}
			if (!ownsSnapshot(context, snapshot)) throw new Error("Only the session that owns this graph may resume it.");
			const graph = await loadValidatedGraph(store, snapshot, config.maxSpawnBudget, true);
			if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed during Graph resume validation.");
			await prepareAttentionResume(store, snapshot);
			const nodeById = new Map(graph.nodes.map((node) => [node.taskId, node]));
			for (const state of Object.values(snapshot.nodes)) {
				if (state.status === "waiting_input") {
					const attempt = state.attempts.at(-1);
					const providerDispatch = attempt?.providerDispatches?.at(-1);
					let asyncId = providerDispatch?.asyncId ?? attempt?.asyncId;
					let asyncDir = providerDispatch?.asyncDir ?? attempt?.asyncDir;
					if (attempt && !asyncId && !asyncDir) {
						const recovered = await recoverSnapshotRun(snapshot, providerDispatch?.sessionDir ?? attempt.sessionDir, ownerSessionFile(context));
						if (recovered) {
							attempt.asyncId = recovered.asyncId;
							attempt.asyncDir = recovered.asyncDir;
							if (providerDispatch) {
								providerDispatch.asyncId = recovered.asyncId;
								providerDispatch.asyncDir = recovered.asyncDir;
							}
							asyncId = recovered.asyncId;
							asyncDir = recovered.asyncDir;
						}
					}
					const childState = asyncId && asyncDir ? await readAsyncRunState(asyncId, asyncDir) : undefined;
					const legacyRoutingBlocked = Boolean(attempt?.routingDecision)
						|| attempt?.failure?.kind === "routing_preflight_drift"
						|| Boolean(nodeById.get(state.taskId)?.routingProfile);
					if (!childState && legacyRoutingBlocked) {
						throw new Error(`Node '${state.taskId}' requires legacy controlled-routing re-evaluation, which is frozen in Runtime v3. pi-graph will not re-route or re-dispatch it; reconcile the run manually or start a new graph.`);
					}
					waitingInputResumeAction(childState, state.taskId);
					state.status = "running";
					state.error = undefined;
					if (attempt) attempt.status = "running";
					continue;
				}
				if (state.status === "stale" && state.attempts.at(-1)?.writesCommittedAt) {
					await store.prepareAttemptRecovery(state.taskId, state.attempts.at(-1)!.attempt, "verifying");
					state.status = "verifying";
					state.error = undefined;
					state.attempts.at(-1)!.status = "verifying";
					continue;
				}
					if (["stale", "dispatch_unknown"].includes(state.status)) {
						const attempt = state.attempts.at(-1);
						if (attempt && !attempt.asyncDir) {
							const recovered = await recoverSnapshotRun(snapshot, attempt.sessionDir, ownerSessionFile(context));
							if (recovered) {
								attempt.asyncId = recovered.asyncId;
								attempt.asyncDir = recovered.asyncDir;
							} else if (state.status === "dispatch_unknown") {
								state.error = undefined;
								continue;
							}
						}
					const childState = attempt?.asyncId && attempt.asyncDir ? await readAsyncRunState(attempt.asyncId, attempt.asyncDir) : undefined;
					waitingInputResumeAction(childState, state.taskId);
					if (state.status === "stale" && attempt) await store.prepareAttemptRecovery(state.taskId, attempt.attempt, "running");
					state.status = "running";
					state.error = undefined;
					if (attempt) attempt.status = "running";
					continue;
				}
				if (state.status === "failed") {
					let retryKind: "dispatch" | "timeout" | "failed" | "validation" | "provider" | "model_degrade" = "failed";
					if (snapshot.schemaVersion === 2) {
						const attempt = state.attempts.at(-1);
						if (attempt) {
							const authority = await store.readAttemptRecord(state.taskId, attempt.attempt);
							if (authority.phase !== "terminal" || authority.terminalStatus !== "failed" || !authority.terminalRetryKind) throw new Error(`Node '${state.taskId}' has no durable failed-attempt retry authorization.`);
							retryKind = authority.terminalRetryKind;
						}
					}
					assertRedispatchAllowed(nodeById.get(state.taskId)!, state, retryKind);
					state.status = "pending";
					state.error = undefined;
					continue;
				}
				if (state.status === "blocked") {
					state.status = "pending";
					state.error = undefined;
				}
			}
			snapshot.status = "queued";
			snapshot.error = undefined;
			snapshot.sessionId = sessionIdentity(context);
			snapshot.supervisorEpoch = randomUUID();
			await store.saveSnapshot(snapshot);
			const routingConfig = undefined;
			if (!this.isCurrent(generation, context) || signal.aborted) throw new Error("Pi session changed before resumed Graph execution launch.");
			this.launch(graph, snapshot, store, releaseSupervisor, routingConfig, generation, context);
			return snapshot;
		} catch (error) {
			await releaseSupervisor();
			throw error;
		}
	}
}

export { graphSummary };

export function waitingInputResumeAction(childState: string | undefined, taskId = "node"): "monitor" {
	if (childState === "paused") {
		throw new Error(`Child for '${taskId}' is still paused. Resume or stop that pi-subagents run first; pi-graph will not create a duplicate child.`);
	}
	if (["queued", "running", "complete"].includes(childState ?? "")) return "monitor";
	throw new Error(`Child state for '${taskId}' is ${childState ?? "missing"}. pi-graph will not replace an ambiguous or terminal child inside the same graph; reconcile it and start a new graph for additional work.`);
}

export function assertRedispatchAllowed(node: CompiledNode, state: NodeRuntimeState, retryKind: "dispatch" | "timeout" | "failed" | "validation" | "provider" | "model_degrade" = "failed"): void {
	if (node.sideEffect === "external_write" || node.allowBash) {
		throw new Error(`Node '${node.taskId}' has ambient or external write authority and cannot be re-dispatched. Start a new graph only after reconciling its side effects.`);
	}
	const current = state.attempts.at(-1);
	const matchingFailures = state.attempts.filter((attempt) => {
		if (attempt.status !== "failed") return false;
		const attemptKind = attempt.failure?.retryKind ?? "failed";
		return retryKind === "provider"
			? attemptKind === "provider"
			: retryKind === "model_degrade" ? attemptKind === "model_degrade" : attemptKind !== "provider" && attemptKind !== "model_degrade";
	}).length;
	const currentKind = current?.failure?.retryKind ?? "failed";
	const currentIncluded = current?.status === "failed" && (retryKind === "provider"
		? currentKind === "provider"
		: retryKind === "model_degrade" ? currentKind === "model_degrade" : currentKind !== "provider" && currentKind !== "model_degrade");
	let used = matchingFailures + (currentIncluded ? 0 : 1);
	if (retryKind === "provider") {
		throw new Error(`Node '${node.taskId}' cannot create a new attempt for a provider retry; provider retries must remain inside the original attempt. Start a new graph after reconciling the terminal failure.`);
	}
	if (retryKind === "model_degrade") {
		throw new Error(`Node '${node.taskId}' model degradation re-dispatch is frozen in Runtime v3; legacy degrade retries cannot be re-dispatched. Start a new graph after reconciling the terminal failure.`);
	}
	const classifiedProviderAttempts = state.attempts.filter((attempt) => ["provider", "model_degrade"].includes(attempt.failure?.retryKind ?? "")).length;
	used = Math.max(used, state.attempt - classifiedProviderAttempts);
	if (used >= node.retryPolicy.maxAttempts) {
		throw new Error(`Node '${node.taskId}' exhausted its ${node.retryPolicy.maxAttempts} declared business attempt(s). Start a new graph to authorize more work.`);
	}
	if (!(node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"]).includes(retryKind)) {
		throw new Error(`Node '${node.taskId}' retry kind '${retryKind}' is not authorized by retryOn.`);
	}
}
