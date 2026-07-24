import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
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
import { runRetentionMaintenance, type RetentionReport } from "./retention.ts";
import { ChildRuntime, type ChildLineage } from "./child-runtime.ts";

interface RunningGraph {
	runner: GraphRunner;
	promise: Promise<GraphSnapshot>;
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

function ownsSnapshot(ctx: ExtensionContext, snapshot: GraphSnapshot): boolean {
	if (!snapshot.sessionId) return true;
	return [ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId()].filter(Boolean).includes(snapshot.sessionId);
}

export async function loadValidatedGraph(store: GraphStore, snapshot: GraphSnapshot, maxSpawnBudget: number) {
	const validated = await loadValidatedRun(store, maxSpawnBudget);
	if (validated.snapshot.graphId !== snapshot.graphId || validated.snapshot.updatedAt !== snapshot.updatedAt) throw new Error("Graph snapshot changed during trusted loading.");
	return validated.graph;
}

export class GraphManager {
	private readonly pi: ExtensionAPI;
	private config?: GraphConfig;
	private context?: ExtensionContext;
	private readonly runners = new Map<string, RunningGraph>();
	private lifecycleGeneration = 0;
	private maintenance?: Promise<RetentionReport>;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
	}

	async initialize(ctx: ExtensionContext): Promise<void> {
		const generation = ++this.lifecycleGeneration;
		this.context = ctx;
		const config = await loadGraphConfig();
		if (generation !== this.lifecycleGeneration || this.context !== ctx) return;
		this.config = config;
		await mkdir(config.runsDir, { recursive: true });
		if (generation !== this.lifecycleGeneration || this.context !== ctx) return;
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
			if (generation !== this.lifecycleGeneration || this.context !== ctx) return;
			if (this.runners.has(graphId)) continue;
			if (inspected && ((inspected.sessionId !== owner && inspected.sessionId !== legacyOwner) || !["queued", "running"].includes(inspected.status))) {
				if (inspected.schemaVersion === 2 && !["queued", "running"].includes(inspected.status)) {
					terminal.push({ graphId, store, snapshot: inspected });
				}
				continue;
			}
			if (inspected) await this.adoptGraph(graphId, store, owner, legacyOwner, config, ctx, generation);
			else void this.adoptGraph(graphId, store, owner, legacyOwner, config, ctx, generation).catch((error) => {
				ctx.ui.notify(`pi-graph background recovery failed '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			});
		}
		void mapWithConcurrency(terminal, 4, async ({ graphId, store, snapshot }) => {
			try {
				await this.enforceTerminalTombstones(store, snapshot, config, ctx);
			} catch (error) {
				ctx.ui.notify(`pi-graph terminal tombstone recovery skipped '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		}).catch(() => undefined);
		void this.maintain(config, ctx).catch(() => undefined);
	}

	private async adoptGraph(
		graphId: string,
		store: GraphStore,
		owner: string | undefined,
		legacyOwner: string | undefined,
		config: GraphConfig,
		ctx: ExtensionContext,
		generation: number,
	): Promise<void> {
		let releaseSupervisor: (() => Promise<void>) | undefined;
		try {
			if (generation !== this.lifecycleGeneration || this.context !== ctx || this.runners.has(graphId)) return;
			releaseSupervisor = await store.acquireSupervisor(randomUUID());
			const validated = await loadOrRebuildValidatedRun(store, config.maxSpawnBudget);
			const snapshot = validated.snapshot;
			if (snapshot.schemaVersion === 2) {
				const childRuntime = new ChildRuntime(new SubagentRpcClient(this.pi.events, config.rpcTimeoutMs));
				for (const state of Object.values(snapshot.nodes)) {
					for (const attempt of state.attempts) {
						if (!attempt.attemptNonce) continue;
						const lineage: ChildLineage = {
							runInstanceId: snapshot.runInstanceId,
							graphId: snapshot.graphId,
							taskId: state.taskId,
							attempt: attempt.attempt,
							attemptNonce: attempt.attemptNonce,
							sessionDir: attempt.sessionDir,
							...(snapshot.sessionId ? { ownerSessionId: snapshot.sessionId } : {}),
						};
						const enforced = await childRuntime.enforceTombstone(lineage);
						if (enforced?.stopped) ctx.ui.notify(`pi-graph stopped a late child for '${graphId}/${state.taskId}' during recovery.`, "warning");
					}
				}
			}
			if ((snapshot.sessionId !== owner && snapshot.sessionId !== legacyOwner) || !["queued", "running"].includes(snapshot.status)) return;
			if (generation !== this.lifecycleGeneration || this.context !== ctx || this.runners.has(graphId)) return;
			snapshot.sessionId = owner;
			snapshot.supervisorEpoch = randomUUID();
			await store.saveSnapshot(snapshot);
			this.launch(validated.graph, snapshot, store, releaseSupervisor);
			releaseSupervisor = undefined;
		} catch (error) {
			if (!(error instanceof GraphAlreadySupervisedError)) {
				await recordProtectedIncident(store, error).catch(() => undefined);
				ctx.ui.notify(`pi-graph recovery skipped '${graphId}': ${error instanceof Error ? error.message : String(error)}`, "warning");
			}
		} finally {
			await releaseSupervisor?.();
		}
	}

	private async enforceTerminalTombstones(store: GraphStore, snapshot: GraphSnapshot, config: GraphConfig, ctx: ExtensionContext): Promise<void> {
		if (snapshot.schemaVersion !== 2) return;
		let hasTombstone = false;
		for (const state of Object.values(snapshot.nodes)) {
			for (const attempt of state.attempts) {
				try {
					await access(store.path("nodes", state.taskId, `attempt-${attempt.attempt}`, "child-tombstone.json"));
					hasTombstone = true;
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
			}
			if (hasTombstone) break;
		}
		if (!hasTombstone) return;
		const validated = await loadValidatedRun(store, config.maxSpawnBudget);
		const childRuntime = new ChildRuntime(new SubagentRpcClient(this.pi.events, config.rpcTimeoutMs));
		for (const state of Object.values(validated.snapshot.nodes)) {
			for (const attempt of state.attempts) {
					if (!attempt.attemptNonce) continue;
					const enforced = await childRuntime.enforceTombstone({
						runInstanceId: snapshot.runInstanceId,
						graphId: snapshot.graphId,
					taskId: state.taskId,
					attempt: attempt.attempt,
					attemptNonce: attempt.attemptNonce,
					sessionDir: attempt.sessionDir,
						...(snapshot.sessionId ? { ownerSessionId: snapshot.sessionId } : {}),
				});
				if (enforced?.stopped) ctx.ui.notify(`pi-graph stopped a late child for '${snapshot.graphId}/${state.taskId}' during terminal recovery.`, "warning");
			}
		}
	}

	private async maintain(config: GraphConfig, ctx?: ExtensionContext): Promise<RetentionReport> {
		if (this.maintenance) return this.maintenance;
		this.maintenance = runRetentionMaintenance(config)
				.then((report) => {
					if (report.overSoftLimit) ctx?.ui.notify("pi-graph storage is over its soft limit. Use /graphs storage to inspect protected data and enable autoPrune only after review.", "warning");
					return report;
				})
				.catch((error) => {
					ctx?.ui.notify(`pi-graph retention maintenance failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
					throw error;
				})
				.finally(() => { this.maintenance = undefined; });
		return this.maintenance;
	}

	async runMaintenance(): Promise<RetentionReport> {
		const { config } = this.requireReady();
		return this.maintain(config, this.context);
	}

	private requireReady(): { config: GraphConfig; context: ExtensionContext } {
		if (!this.config || !this.context) throw new Error("pi-graph has no active Pi session.");
		if (!this.config.enabled) throw new Error("pi-graph is disabled in settings.json.");
		return { config: this.config, context: this.context };
	}

	private launch(graph: ReturnType<typeof compileGraph>, snapshot: GraphSnapshot, store: GraphStore, releaseSupervisor?: () => Promise<void>): void {
		if (this.runners.has(graph.graphId)) {
			void releaseSupervisor?.();
			return;
		}
		const { config } = this.requireReady();
		const leases = new LeaseRegistry(join(config.runsDir, ".control", "leases"));
		const runner = new GraphRunner(graph, snapshot, store, this.pi.events, leases, config, (terminal) => {
			const activeSessionId = this.context ? sessionIdentity(this.context) : undefined;
			if (config.notifyOnComplete && activeSessionId === terminal.sessionId && terminal.status !== "stopped") {
				this.pi.sendMessage({
					customType: "pi-graph-result",
					content: `[pi-graph ${terminal.status}]\n${graphSummary(terminal, this.config?.runsDir)}\nInspect rejected or blocked nodes before claiming the overall goal is complete.`,
					display: true,
					details: terminal,
				}, { triggerTurn: true, deliverAs: "followUp" });
			} else if (activeSessionId === terminal.sessionId && terminal.status === "stopped") {
				this.context?.ui.notify(`pi-graph '${graph.graphId}' stopped.`, "info");
			}
			void this.maintain(config, this.context).catch(() => undefined);
		});
		const promise = runner.run(releaseSupervisor).catch(async (error) => {
			if (error instanceof GraphAlreadySupervisedError) {
				this.context?.ui.notify(`pi-graph '${graph.graphId}' is already supervised by another active Pi process.`, "warning");
				return snapshot;
			}
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
						this.context?.ui.notify(`pi-graph could not persist failure recovery for '${graph.graphId}': ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`, "warning");
					}
				} finally {
					await releaseRecovery?.();
				}
			}
			const message = error instanceof Error ? error.message : String(error);
			this.context?.ui.notify(`pi-graph '${graph.graphId}' stopped: ${message}`, "error");
			return authoritative ?? snapshot;
		}).finally(() => {
			const current = this.runners.get(graph.graphId);
			if (current?.runner === runner) this.runners.delete(graph.graphId);
		});
		this.runners.set(graph.graphId, { runner, promise });
	}

	async start(spec: GraphSpec): Promise<GraphSnapshot> {
		const { config, context } = this.requireReady();
		const graph = compileGraph(spec, context.cwd, config.maxSpawnBudget, 2);
		const store = new GraphStore(config.runsDir, graph.graphId);
		const snapshot = initialSnapshot(graph, context.cwd, sessionIdentity(context), 2);
		await store.initialize(graph, snapshot);
		const releaseSupervisor = await store.acquireSupervisor(snapshot.supervisorEpoch);
		try {
			const authoritative = await store.loadSnapshot();
			this.launch(graph, authoritative, store, releaseSupervisor);
			return authoritative;
		} catch (error) {
			await releaseSupervisor();
			throw error;
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
		validateGraphId(graphId);
		const active = this.runners.get(graphId);
		const store = new GraphStore(config.runsDir, graphId);
		if (active) {
			await store.recordDesiredState("stopped");
			active.runner.stop();
			return active.promise;
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
				snapshot = await store.loadSnapshot();
				if (!ownsSnapshot(context, snapshot)) throw new Error("Graph ownership changed while acquiring its Supervisor claim.");
				if (["complete", "failed", "blocked", "stopped"].includes(snapshot.status)) return snapshot;
				if (snapshot.schemaVersion === 2) {
					await loadValidatedRun(store, config.maxSpawnBudget);
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
				await store.recordDesiredState("stopped");
			if (["queued", "running"].includes(snapshot.status)) {
				const graph = await loadValidatedGraph(store, snapshot, config.maxSpawnBudget);
				const runner = new GraphRunner(graph, snapshot, store, this.pi.events, new LeaseRegistry(join(config.runsDir, ".control", "leases")), config);
				const claimed = releaseSupervisor;
				releaseSupervisor = undefined;
				return runner.run(claimed);
			}
			let uncertainStop = Object.values(snapshot.nodes).some((state) => state.status === "stale");
			const rpc = new SubagentRpcClient(this.pi.events, config.rpcTimeoutMs);
			const childRuntime = new ChildRuntime(rpc);
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
					let identity = attempt?.asyncId && attempt.asyncDir ? { asyncId: attempt.asyncId, asyncDir: attempt.asyncDir } : null;
					if (!identity && attempt?.sessionDir) {
						try {
							identity = await recoverRunBySessionDir(attempt.sessionDir, undefined, snapshot.sessionId);
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
								sessionDir: attempt.sessionDir,
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
						try {
							await rpc.call("stop", { id: identity.asyncId });
						} catch {
							await requestAsyncStop(identity.asyncDir);
						}
						if (!await waitForConfirmedStop(identity.asyncDir, 30_000)) throw new Error("child did not reach the stopped state");
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
		const generation = ++this.lifecycleGeneration;
		const context = this.context;
		const active = [...this.runners.values()];
		for (const entry of active) entry.runner.suspend();
		await Promise.allSettled(active.map((entry) => entry.promise));
		if (generation === this.lifecycleGeneration && this.context === context) this.context = undefined;
	}

	listActiveWork(): Array<{ id: string; sessionId: string }> {
		return [...this.runners.entries()].flatMap(([id, entry]) => entry.runner.snapshot.sessionId ? [{ id, sessionId: entry.runner.snapshot.sessionId }] : []);
	}

	async resume(graphId: string): Promise<GraphSnapshot> {
		const { config, context } = this.requireReady();
		validateGraphId(graphId);
		if (this.runners.has(graphId)) return this.status(graphId);
		const store = new GraphStore(config.runsDir, graphId);
		const releaseSupervisor = await store.acquireSupervisor(randomUUID());
		try {
			const snapshot = await store.loadSnapshot();
			if (["complete", "failed", "blocked", "stopped"].includes(snapshot.status) || await store.readDesiredState() === "stopped") {
				throw new Error(`Graph status '${snapshot.status}' is final and cannot be resumed; start a new graph run.`);
			}
			if (!ownsSnapshot(context, snapshot)) throw new Error("Only the session that owns this graph may resume it.");
			const graph = await loadValidatedGraph(store, snapshot, config.maxSpawnBudget);
			const nodeById = new Map(graph.nodes.map((node) => [node.taskId, node]));
			for (const state of Object.values(snapshot.nodes)) {
				if (state.status === "waiting_input") {
					const attempt = state.attempts.at(-1);
					const childState = attempt?.asyncId && attempt.asyncDir ? await readAsyncRunState(attempt.asyncId, attempt.asyncDir) : undefined;
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
							const recovered = await recoverRunBySessionDir(attempt.sessionDir, undefined, snapshot.sessionId);
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
					let retryKind: "dispatch" | "timeout" | "failed" | "validation" | "provider" = "failed";
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
			this.launch(graph, snapshot, store, releaseSupervisor);
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

export function assertRedispatchAllowed(node: CompiledNode, state: NodeRuntimeState, retryKind: "dispatch" | "timeout" | "failed" | "validation" | "provider" = "failed"): void {
	if (node.sideEffect === "external_write" || node.allowBash) {
		throw new Error(`Node '${node.taskId}' has ambient or external write authority and cannot be re-dispatched. Start a new graph only after reconciling its side effects.`);
	}
	const matchingFailures = state.attempts.filter((attempt) => {
		if (attempt.status !== "failed") return false;
		const attemptKind = attempt.failure?.retryKind ?? "failed";
		return retryKind === "provider" ? attemptKind === "provider" : attemptKind !== "provider";
	}).length;
	const current = state.attempts.at(-1);
	const currentKind = current?.failure?.retryKind ?? "failed";
	const currentIncluded = current?.status === "failed" && (retryKind === "provider" ? currentKind === "provider" : currentKind !== "provider");
	let used = matchingFailures + (currentIncluded ? 0 : 1);
	if (retryKind === "provider") {
		if (used > (node.retryPolicy.maxProviderRetries ?? 0)) {
			throw new Error(`Node '${node.taskId}' exhausted its ${node.retryPolicy.maxProviderRetries ?? 0} declared provider retry/retries. Start a new graph to authorize more work.`);
		}
		return;
	}
	const classifiedProviderAttempts = state.attempts.filter((attempt) => attempt.failure?.retryKind === "provider").length;
	used = Math.max(used, state.attempt - classifiedProviderAttempts);
	if (used >= node.retryPolicy.maxAttempts) {
		throw new Error(`Node '${node.taskId}' exhausted its ${node.retryPolicy.maxAttempts} declared business attempt(s). Start a new graph to authorize more work.`);
	}
	if (!(node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"]).includes(retryKind)) {
		throw new Error(`Node '${node.taskId}' retry kind '${retryKind}' is not authorized by retryOn.`);
	}
}
