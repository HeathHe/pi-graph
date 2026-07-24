import { randomUUID } from "node:crypto";
import type { CompiledGraph, CompiledNode, FailureDetails, GraphConfig, GraphSnapshot, GraphStatus, NodeExecutionResult, NodeRuntimeState, RetryKind } from "./types.ts";
import { GraphStore } from "./store.ts";
import { LeaseRegistry } from "./leases.ts";
import { NodeExecutor, type TransitionOptions } from "./executor.ts";
import { SubagentRpcClient, type EventBus } from "./rpc.ts";
import { reopenWorkspace } from "./workspace.ts";
import { loadValidatedRun } from "./reconciler.ts";

const NODE_TERMINAL = new Set(["accepted", "blocked", "failed", "stale", "stopped", "waiting_input"]);
const ATTEMPT_STATUSES = new Set(["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying", "accepted", "waiting_input", "stale", "failed", "stopped"]);

function failureFor(result: NodeExecutionResult): FailureDetails | undefined {
	if (result.failure) return result.failure;
	if (!result.retryKind) return undefined;
	return {
		kind: result.retryKind === "provider" ? "provider_transient"
			: result.retryKind === "timeout" ? "hard_deadline"
				: result.retryKind === "dispatch" ? "dispatch_rejected"
					: result.retryKind === "validation" ? "validation"
						: "task_failed",
		retryKind: result.retryKind,
	};
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function initialSnapshot(graph: CompiledGraph, sourceCwd: string, sessionId?: string, runtimeVersion: 1 | 2 = 1): GraphSnapshot {
	const now = new Date().toISOString();
	const base = {
		graphId: graph.graphId,
		status: "queued" as const,
		goal: graph.goal,
		sourceCwd,
		...(sessionId ? { sessionId } : {}),
		createdAt: now,
		updatedAt: now,
		supervisorEpoch: randomUUID(),
		nodes: Object.fromEntries(graph.nodes.map((node) => [node.taskId, { taskId: node.taskId, status: "pending" as const, attempt: 0, attempts: [] }])),
	};
	if (runtimeVersion === 2) return {
		...base,
		schemaVersion: 2,
		runInstanceId: randomUUID(),
		lifecycleRevision: 0,
		fencingGeneration: 0,
	};
	return {
		...base,
		schemaVersion: 1,
	};
}

export class GraphRunner {
	readonly graph: CompiledGraph;
	readonly snapshot: GraphSnapshot;
	private readonly store: GraphStore;
	private readonly config: GraphConfig;
	private readonly events: EventBus;
	private readonly onTerminal?: (snapshot: GraphSnapshot) => void;
	private readonly active = new Map<string, Promise<void>>();
	private readonly abort = new AbortController();
	private persistQueue = Promise.resolve();
	private userStopped = false;
	private suspended = false;
	private failFastTriggered = false;
	private stopActiveNodes = new Set<string>();

	constructor(
		graph: CompiledGraph,
		snapshot: GraphSnapshot,
		store: GraphStore,
		events: EventBus,
		leases: LeaseRegistry,
		config: GraphConfig,
		onTerminal?: (snapshot: GraphSnapshot) => void,
	) {
		this.graph = graph;
		this.snapshot = snapshot;
		this.store = store;
		this.config = config;
		this.events = events;
		this.onTerminal = onTerminal;
		const rpc = new SubagentRpcClient(events, config.rpcTimeoutMs);
		this.executor = new NodeExecutor(
			graph,
			store,
			rpc,
			events,
			leases,
			config,
			snapshot.supervisorEpoch,
			snapshot.sessionId,
			snapshot.schemaVersion === 2 ? { runInstanceId: snapshot.runInstanceId, fencingGeneration: snapshot.fencingGeneration } : {},
			this.transition.bind(this),
		);
	}

	private readonly executor: NodeExecutor;

	private enqueuePersistence(operation: () => Promise<void>): Promise<void> {
		const current = this.persistQueue.then(operation);
		this.persistQueue = current.catch(() => undefined);
		return current;
	}

	private transition(taskId: string, status: NodeRuntimeState["status"], patch: Partial<NodeRuntimeState["attempts"][number]> = {}, error?: string, options: TransitionOptions = {}): Promise<void> {
		return this.enqueuePersistence(async () => {
			const state = this.snapshot.nodes[taskId]!;
			if (options.appendAttempt) {
				if (options.appendAttempt.attempt !== state.attempt + 1) throw new Error(`Invalid attempt append for ${taskId}/${options.appendAttempt.attempt}.`);
				state.attempt = options.appendAttempt.attempt;
				state.attempts.push(options.appendAttempt);
			}
			Object.assign(state, options.statePatch);
			state.status = status;
			state.error = error;
			const attempt = state.attempts.at(-1);
			if (attempt) {
				Object.assign(attempt, patch);
				if (ATTEMPT_STATUSES.has(status)) attempt.status = status;
			}
			await this.store.saveSnapshot(this.snapshot);
			await this.store.event(`node.${status}`, error ? { error } : undefined, taskId).catch(() => undefined);
			try { this.events.emit("pi-graph:state", { graphId: this.graph.graphId, taskId, status }); } catch { /* observer failures do not change authoritative state */ }
		});
	}

	private async setGraphStatus(status: GraphStatus, error?: string): Promise<void> {
		await this.enqueuePersistence(async () => {
			this.snapshot.status = status;
			this.snapshot.error = error;
			await this.store.saveSnapshot(this.snapshot);
			await this.store.event(`graph.${status}`, error ? { error } : undefined).catch(() => undefined);
			try { this.events.emit("pi-graph:state", { graphId: this.graph.graphId, status }); } catch { /* observer failures do not change authoritative state */ }
		});
	}

	private async recoverDurableStop(): Promise<void> {
		for (const state of Object.values(this.snapshot.nodes)) {
			if (["accepted", "failed", "blocked", "stale", "stopped"].includes(state.status)) continue;
			const attempt = state.attempts.at(-1);
			const node = this.graph.nodes.find((candidate) => candidate.taskId === state.taskId)!;
			if (attempt && this.snapshot.schemaVersion === 2) {
				if (await this.projectAcceptedAuthority(state)) continue;
				const authoritative = await this.executor.authoritativeTerminalResult(state);
				if (authoritative && ["failed", "stale", "stopped"].includes(authoritative.status)) {
					const terminalStatus = authoritative.status as "failed" | "stale" | "stopped";
					state.status = terminalStatus;
					state.error = authoritative.error;
					Object.assign(attempt, {
						status: terminalStatus,
						endedAt: attempt.endedAt ?? new Date().toISOString(),
						...(authoritative.error ? { error: authoritative.error } : {}),
					});
					continue;
				}
			}
				const childMayBeActive = attempt
					&& ["running", "dispatching", "dispatch_unknown", "waiting_input", "resource_wait"].includes(attempt.status)
					&& ["running", "dispatching", "dispatch_unknown", "waiting_input", "resource_wait"].includes(state.status);
			if (attempt && childMayBeActive) {
				const stopped = await this.executor.stopRecoveredAttempt(node, attempt);
				if (!stopped.stopped) {
					state.status = "stale";
					attempt.status = "stale";
					state.error = stopped.error;
					await this.executor.recordTerminalResult(node, state, { status: "stale", error: stopped.error });
					continue;
				}
			}
			if (attempt && ["collecting", "verifying"].includes(state.status)) {
				try {
					let applyStatus = await this.store.readApplyPlanStatus(state.taskId, attempt.attempt);
					if (applyStatus === "applying") {
						if (!attempt.workspaceDir || !attempt.workspaceKind) throw new Error("Interrupted apply has no recoverable workspace metadata.");
						const controller = new AbortController();
						controller.abort("stop");
						try {
							await (await reopenWorkspace(this.graph.nodes.find((node) => node.taskId === state.taskId)!, attempt.workspaceDir, attempt.workspaceKind)).apply(controller.signal);
						} catch (error) {
							if (!(error instanceof Error) || !error.message.includes("aborted")) throw error;
						}
						applyStatus = await this.store.readApplyPlanStatus(state.taskId, attempt.attempt);
					}
					if (applyStatus === "committed") {
						state.status = "stale";
						attempt.status = "stale";
						attempt.writesCommittedAt ??= new Date().toISOString();
						state.error = "Source commit completed before durable stop; deterministic finalization requires operator attention.";
						await this.executor.recordTerminalResult(node, state, { status: "stale", error: state.error });
						continue;
					}
					if (applyStatus === "applying") throw new Error("Interrupted apply remained in applying state after recovery.");
				} catch (error) {
					state.status = "stale";
					attempt.status = "stale";
					state.error = `Durable stop could not recover source apply: ${error instanceof Error ? error.message : String(error)}`;
					await this.executor.recordTerminalResult(node, state, { status: "stale", error: state.error });
					continue;
				}
			}
			state.status = "stopped";
			state.error = undefined;
			if (attempt) attempt.status = "stopped";
			await this.executor.recordTerminalResult(node, state, { status: "stopped" });
		}
		await this.store.saveSnapshot(this.snapshot);
	}

	private async projectAcceptedAuthority(state: NodeRuntimeState): Promise<boolean> {
		if (this.snapshot.schemaVersion !== 2) return false;
		const attempt = state.attempts.at(-1);
		if (!attempt) return false;
		const authority = await this.store.readAttemptRecord(state.taskId, attempt.attempt);
		if (authority.phase !== "accepted") return false;
		await loadValidatedRun(this.store, this.config.maxSpawnBudget);
		state.status = "accepted";
		state.error = undefined;
		state.failure = undefined;
		state.nextRetryAt = undefined;
		state.resourceWaitStartedAt = undefined;
		Object.assign(attempt, {
			status: "accepted",
			endedAt: attempt.endedAt ?? authority.updatedAt,
			manifestPath: attempt.manifestPath ?? this.store.path("nodes", state.taskId, `attempt-${attempt.attempt}`, "result-manifest.json"),
		});
		return true;
	}

	private dependenciesAccepted(taskId: string): boolean {
		const node = this.graph.nodes.find((candidate) => candidate.taskId === taskId)!;
		return node.dependsOn.every((dependency) => this.snapshot.nodes[dependency]?.status === "accepted");
	}

	private async reconcile(): Promise<void> {
		const failed = new Set(Object.values(this.snapshot.nodes).filter((state) => ["failed", "blocked", "stale", "stopped", "waiting_input"].includes(state.status)).map((state) => state.taskId));
		for (const id of this.graph.topologicalOrder) {
			const state = this.snapshot.nodes[id]!;
			if (NODE_TERMINAL.has(state.status) || this.active.has(id)) continue;
			const node = this.graph.nodes.find((candidate) => candidate.taskId === id)!;
			if (node.dependsOn.some((dependency) => failed.has(dependency))) {
				await this.transition(id, "blocked", {}, "A dependency did not reach ACCEPTED.");
				failed.add(id);
				continue;
			}
			if (["retry_wait", "resource_wait"].includes(state.status) && (state.nextRetryAt ?? 0) <= Date.now()) {
				const currentAttempt = state.attempts.at(-1);
				const recoveredStatus = currentAttempt && ["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(currentAttempt.status)
					? currentAttempt.status
					: "pending";
				await this.transition(id, recoveredStatus);
			}
			if (state.status === "pending" && this.dependenciesAccepted(id)) await this.transition(id, "ready");
		}
	}

	private async recoverAuthoritativeTerminalAttempts(): Promise<void> {
		if (this.snapshot.schemaVersion !== 2) return;
		let changed = false;
		for (const state of Object.values(this.snapshot.nodes)) {
			if (["accepted", "failed", "blocked", "stale", "stopped"].includes(state.status)) continue;
			if (await this.projectAcceptedAuthority(state)) {
				changed = true;
				continue;
			}
			if (!["leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(state.status)) continue;
			const result = await this.executor.authoritativeTerminalResult(state);
			if (!result || !["failed", "stale", "stopped"].includes(result.status)) continue;
			const terminalStatus = result.status as "failed" | "stale" | "stopped";
			if (terminalStatus === "stale" && await this.store.hasAttemptRecovery(state.taskId, state.attempt)) continue;
			const node = this.graph.nodes.find((candidate) => candidate.taskId === state.taskId)!;
			const attempt = state.attempts.at(-1);
			if (!attempt) continue;
			const failure = failureFor(result);
			Object.assign(attempt, { status: terminalStatus, endedAt: new Date().toISOString(), ...(result.error ? { error: result.error } : {}), ...(failure ? { failure } : {}) });
			state.failure = failure;
			if (terminalStatus === "failed" && this.retryAllowed(node, state, result)) {
				state.status = "retry_wait";
				state.nextRetryAt = Date.now() + this.retryDelay(node, state, result);
			} else {
				state.status = terminalStatus;
				state.nextRetryAt = undefined;
				if (this.graph.failFast && terminalStatus !== "stopped") this.failFastTriggered = true;
			}
			state.error = result.error;
			changed = true;
		}
		if (changed) await this.store.saveSnapshot(this.snapshot);
	}

	private capacityFor(nodeId: string): number {
		const node = this.graph.nodes.find((candidate) => candidate.taskId === nodeId)!;
		const readOnly = ["none", "local_read", "external_read"].includes(node.sideEffect);
		return Math.min(this.config.maxConcurrency, readOnly ? Math.max(this.graph.maxConcurrency, this.config.readOnlyBurst) : this.graph.maxConcurrency);
	}

	private resourceKey(node: CompiledNode): string {
		return node.resourceClass ?? `agent:${node.agent}`;
	}

	private retryFailureCount(state: NodeRuntimeState, result: NodeExecutionResult): number {
		const retryKind = result.retryKind ?? "failed";
		const matches = (attempt: NodeRuntimeState["attempts"][number]) => {
			const attemptKind = attempt.failure?.retryKind ?? "failed";
			return retryKind === "provider" ? attemptKind === "provider" : attemptKind !== "provider";
		};
		const recorded = state.attempts.filter((attempt) => attempt.status === "failed" && matches(attempt)).length;
		const last = state.attempts.at(-1);
		const currentRecorded = last?.status === "failed" && matches(last);
		return recorded + (currentRecorded ? 0 : 1);
	}

	private retryAllowed(node: CompiledNode, state: NodeRuntimeState, result: NodeExecutionResult): boolean {
		const retryKind: RetryKind = result.retryKind ?? "failed";
		const used = this.retryFailureCount(state, result);
		if (retryKind === "provider") return used <= (node.retryPolicy.maxProviderRetries ?? 0);
		const retryOn = node.retryPolicy.retryOn ?? ["dispatch", "timeout", "failed", "validation"];
		return retryOn.includes(retryKind as "dispatch" | "timeout" | "failed" | "validation") && used < node.retryPolicy.maxAttempts;
	}

	private retryDelay(node: CompiledNode, state: NodeRuntimeState, result: NodeExecutionResult): number {
		if (result.retryKind !== "provider") return node.retryPolicy.backoffMs ?? 1_000;
		const used = this.retryFailureCount(state, result);
		const exponential = Math.min((node.retryPolicy.providerBackoffMs ?? 5_000) * (2 ** Math.max(0, used - 1)), 300_000);
		return Math.max(exponential, result.failure?.retryAfterMs ?? 0);
	}

	private resourceCoolingDown(node: CompiledNode): boolean {
		const key = this.resourceKey(node);
		const now = Date.now();
		return this.graph.nodes.some((candidate) => {
			if (this.resourceKey(candidate) !== key) return false;
			const state = this.snapshot.nodes[candidate.taskId];
			return state?.status === "retry_wait"
				&& state.failure?.retryKind === "provider"
				&& (state.nextRetryAt ?? 0) > now;
		});
	}

	private canStart(nodeId: string): boolean {
		const node = this.graph.nodes.find((candidate) => candidate.taskId === nodeId)!;
		if (this.active.size >= this.capacityFor(nodeId)) return false;
		if (this.resourceCoolingDown(node)) return false;
		const resourceKey = this.resourceKey(node);
		const resourceLimit = this.config.resourceLimits?.[resourceKey];
		if (resourceLimit !== undefined) {
			const activeInClass = [...this.active.keys()].filter((id) => {
				const activeNode = this.graph.nodes.find((candidate) => candidate.taskId === id);
				return activeNode && this.resourceKey(activeNode) === resourceKey;
			}).length;
			if (activeInClass >= resourceLimit) return false;
		}
		if (node.parallelizable === false && this.active.size > 0) return false;
		return ![...this.active.keys()].some((id) => this.graph.nodes.find((candidate) => candidate.taskId === id)?.parallelizable === false);
	}

	private startNode(taskId: string): void {
		const node = this.graph.nodes.find((candidate) => candidate.taskId === taskId)!;
		const state = this.snapshot.nodes[taskId]!;
		const promise = this.executor.execute(node, state, this.abort.signal)
			.catch((error): NodeExecutionResult => ({
				status: "failed",
				error: error instanceof Error ? error.message : String(error),
				retryKind: "failed",
				failure: { kind: "task_failed", retryKind: "failed" },
			}))
			.then((result) => this.handleResult(node.taskId, result))
			.finally(() => { this.active.delete(taskId); });
		this.active.set(taskId, promise);
	}

	private async handleResult(taskId: string, result: NodeExecutionResult): Promise<void> {
		if (result.status === "accepted") {
			await this.enqueuePersistence(async () => {
				const state = this.snapshot.nodes[taskId]!;
				state.resourceWaitStartedAt = undefined;
				state.nextRetryAt = undefined;
				state.failure = undefined;
				await this.store.saveSnapshot(this.snapshot);
			});
			return;
		}
		if (result.status === "suspended") return;
		const node = this.graph.nodes.find((candidate) => candidate.taskId === taskId)!;
		const state = this.snapshot.nodes[taskId]!;
		await this.executor.recordTerminalResult(node, state, result);
		if (result.status === "resource_wait") {
			const resourceWaitStartedAt = state.resourceWaitStartedAt ?? Date.now();
			await this.transition(taskId, "resource_wait", {}, result.error, {
				statePatch: { resourceWaitStartedAt, nextRetryAt: Date.now() + 1_000, failure: undefined },
			});
			return;
		}
		const failure = failureFor(result);
		if (result.status === "failed" && this.retryAllowed(node, state, result)) {
			await this.transition(taskId, "retry_wait", {
				status: "failed",
				endedAt: new Date().toISOString(),
				error: result.error,
				failure,
				...(result.manifestPath ? { manifestPath: result.manifestPath } : {}),
			}, result.error, {
				statePatch: {
					resourceWaitStartedAt: undefined,
					nextRetryAt: Date.now() + this.retryDelay(node, state, result),
					failure,
				},
			});
			return;
		}
		await this.transition(taskId, result.status, {
			endedAt: new Date().toISOString(),
			error: result.error,
			failure,
			...(result.manifestPath ? { manifestPath: result.manifestPath } : {}),
		}, result.error, {
			statePatch: { resourceWaitStartedAt: undefined, nextRetryAt: undefined, failure },
		});
		if (this.graph.failFast && result.status !== "stopped") {
			this.failFastTriggered = true;
			this.abort.abort("fail-fast");
		}
	}

	async run(preacquiredSupervisor?: () => Promise<void>): Promise<GraphSnapshot> {
		const releaseSupervisor = preacquiredSupervisor ?? await this.store.acquireSupervisor(this.snapshot.supervisorEpoch);
		try {
			const latest = await this.store.loadSnapshot();
			Object.assign(this.snapshot, latest);
			this.executor.setSupervisorIdentity(this.snapshot.supervisorEpoch, this.snapshot.sessionId, this.store.currentFencingGeneration());
			await this.recoverAuthoritativeTerminalAttempts();
			if (!["queued", "running"].includes(this.snapshot.status)) return this.snapshot;
			const desiredStop = await this.store.readDesiredState() === "stopped";
			const requestedStop = await this.store.consumeControl("stop");
			if (desiredStop || requestedStop) {
				await this.recoverDurableStop();
				this.stop();
			}
			if (!this.userStopped) await this.setGraphStatus("running");
			while (!this.userStopped && !this.suspended && !this.failFastTriggered) {
				const desiredStopWhileRunning = await this.store.readDesiredState() === "stopped";
				const requestedStopWhileRunning = await this.store.consumeControl("stop");
				if (desiredStopWhileRunning || requestedStopWhileRunning) {
					this.stop();
					break;
				}
				await this.reconcile();
				const candidates = this.graph.topologicalOrder
					.filter((id) => ["ready", "leased", "dispatching", "dispatch_unknown", "running", "collecting", "verifying"].includes(this.snapshot.nodes[id]?.status ?? "") && !this.active.has(id))
					.sort((a, b) => (this.graph.nodes.find((node) => node.taskId === b)?.priority ?? 0) - (this.graph.nodes.find((node) => node.taskId === a)?.priority ?? 0));
				for (const id of candidates) if (this.canStart(id)) this.startNode(id);
				const states = Object.values(this.snapshot.nodes);
				if (states.every((state) => NODE_TERMINAL.has(state.status))) break;
				if (this.active.size) await Promise.race([...this.active.values(), delay(250)]);
				else await delay(Math.min(1_000, Math.max(50, Math.min(...states.map((state) => Math.max(0, (state.nextRetryAt ?? Date.now() + 1_000) - Date.now()))))));
				}
				if (this.active.size) await Promise.allSettled(this.active.values());
				if (this.failFastTriggered) await this.recoverDurableStop();
				const states = Object.values(this.snapshot.nodes);
			if (this.suspended) return this.snapshot;
			const crossedCommitPoint = [...this.stopActiveNodes].some((taskId) => {
				const state = this.snapshot.nodes[taskId];
				return state?.status === "accepted" && Boolean(state.attempts.at(-1)?.writesCommittedAt);
			});
			if (this.userStopped && states.some((state) => state.status === "stale" || state.status === "dispatch_unknown")) await this.setGraphStatus("needs_attention", "One or more child stops could not be confirmed.");
			else if (this.userStopped && states.every((state) => state.status === "accepted")) await this.setGraphStatus("complete");
			else if (this.userStopped && crossedCommitPoint) await this.setGraphStatus("needs_attention", "Stop arrived after a node crossed its source commit point; committed work was finalized, while remaining work was stopped.");
			else if (this.userStopped) await this.setGraphStatus("stopped");
			else if (states.some((state) => state.status === "stale" || state.status === "waiting_input" || state.status === "dispatch_unknown")) await this.setGraphStatus("needs_attention");
			else if (this.failFastTriggered) await this.setGraphStatus("failed", "Graph stopped after fail-fast node failure.");
			else if (states.every((state) => state.status === "accepted")) await this.setGraphStatus("complete");
			else if (states.some((state) => state.status === "failed")) await this.setGraphStatus("failed");
			else await this.setGraphStatus("blocked");
			try {
				this.onTerminal?.(this.snapshot);
			} catch (error) {
				await this.store.event("graph.notification_failed", { error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
			}
			return this.snapshot;
		} catch (error) {
			this.abort.abort("runtime-failure");
			await Promise.allSettled(this.active.values());
			await this.persistQueue;
			try {
				this.snapshot.status = "needs_attention";
				this.snapshot.error = error instanceof Error ? error.message : String(error);
				await this.store.saveSnapshot(this.snapshot);
				await this.store.event("graph.runtime_failed", { error: this.snapshot.error });
			} catch {
				// The original runtime failure remains primary; manager recovery will retry under a fresh claim.
			}
			throw error;
		} finally {
			await releaseSupervisor();
		}
	}

	stop(): void {
		this.stopActiveNodes = new Set(this.active.keys());
		this.userStopped = true;
		this.abort.abort("stop");
	}

	suspend(): void {
		this.suspended = true;
		this.abort.abort("suspend");
	}
}
