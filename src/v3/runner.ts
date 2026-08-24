import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SubagentRpcClient } from "./rpc.ts";
import { V3WorkspaceConflictError } from "./workspace.ts";
import { atomicWriteFile, atomicWriteJson, createDurableFile } from "./durable.ts";
import { initializeV3RunControl, readV3RunControl } from "./control.ts";
import { buildV3DependencyCapsule, renderV3DependencyCapsule } from "./capsule.ts";
import {
	readLatestV3Attempt,
	V3_MAX_ATTEMPTS_PER_NODE,
	validateV3Attempt,
	verifyV3AcceptedAttemptChain,
	v3AcceptedAttemptBasis,
	v3RunPaths,
	writeV3AcceptanceEvidence,
	writeV3AttemptEvidence,
	writeV3ValidatedResult,
} from "./attempt.ts";
import { canonicalDigest } from "./digests.ts";
import {
	V3DispatchError,
	v3DispatchChild,
	v3DispatchRequestDigest,
	v3MonitorChild,
	v3PreflightAgent,
	v3RecoverDispatchBinding,
	v3StopChild,
	type V3DispatchSpec,
} from "./dispatch.ts";
import { V3EventWriter } from "./events.ts";
import { acquireV3RunLease, type V3LeaseHandle } from "./lease.ts";
import { readV3MutationJournal, type V3GraphMutationState, type V3MutationCapability } from "./mutations.ts";
import { buildV3SnapshotProjection } from "./projection.ts";
import { v3EvaluateNodeReadiness, v3NodeTerminalOf, v3PendingNodes, v3ReadyNodes, v3SyntheticNodeStatuses, type V3NodeSchedulingStatus } from "./scheduler.ts";
import { runV3Validations } from "./verify.ts";
import { prepareV3Workspace, reopenV3Workspace, type V3PreparedWorkspace } from "./workspace.ts";
import type { RetryReasonV3 } from "./types.ts";
import type {
	AuthorizationV4,
	CompiledGraphNodeV3,
	CompiledGraphV3,
	GraphSnapshotV3,
	V3AcceptanceEvidence,
	V3AttemptEvidence,
	V3ChildOutcome,
	V3FailureKind,
	V3FileDigest,
	V3NodePhase,
	V3ValidatedResult,
	V3WorkspaceEvidence,
} from "./types.ts";

const RETRY_BACKOFF_BASE_MS = 250;
const RESUME_POLL_MS = 250;

export interface V3GraphRunOptions {
	rpc: SubagentRpcClient;
	runDir: string;
	graph: CompiledGraphV3;
	/** Immutable authorization source; graph may already be its effective replay. */
	baseGraph?: CompiledGraphV3;
	authorization: AuthorizationV4;
	sourceCwd: string;
	sessionId: string;
	supervisorEpoch: string;
	maxConcurrency?: number;
	validationTimeoutMs?: number;
	/** Bounded confirmation window after a timeout/stop request (default 5s). */
	childStopTimeoutMs?: number;
	streamLimitBytes?: number;
	failFast?: boolean;
	protectedSourceRoots?: string[];
	signal?: AbortSignal;
	onSnapshot?: (snapshot: GraphSnapshotV3) => void;
	eventLog?: V3EventWriter;
	lease?: V3LeaseHandle;
	/** Durable retry record: schedule exactly one new Attempt after this baseline. */
	retryBaselines?: Readonly<Record<string, number>>;
	/** Injectable agent preflight (default: pi-subagents public preflight). Tests may stub it. */
	preflightAgent?: (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void>;
}

interface NodeRunState {
	attempt: number;
	phase: V3NodePhase | undefined;
	terminal?: V3NodePhase;
	retryAt?: number;
}

export function v3RetryScheduledFor(node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): boolean {
	if (!evidence.failure) return false;
	if (evidence.failure.kind === "dispatch_unknown") return false;
	if (evidence.attempt >= V3_MAX_ATTEMPTS_PER_NODE) return false;
	if (evidence.attempt >= node.retryPolicy.maxAttempts) return false;
	return node.retryPolicy.retryOn.includes(evidence.failure.kind as RetryReasonV3);
}

export class V3GraphRunner {
	readonly options: V3GraphRunOptions;
	readonly paths: ReturnType<typeof v3RunPaths>;
	private readonly state = new Map<string, NodeRunState>();
	private readonly nodeAborts = new Map<string, AbortController>();
	private readonly activeBindings = new Map<string, { asyncId: string; asyncDir: string }>();
	private readonly childStopRequests = new Map<string, Promise<unknown>>();
	private readonly resumeActions = new Map<string, () => Promise<void>>();
	private readonly baseGraph: CompiledGraphV3;
	private graph: CompiledGraphV3;
	private mutationState: V3GraphMutationState;
	private synthetic = new Map<string, "skipped" | "blocked" | "cancelled">();
	private stopRequested = false;
	private pauseRequested = false;
	private runPromise: Promise<GraphSnapshotV3> | undefined;
	private eventWriter: V3EventWriter;
	private activeLease: V3LeaseHandle | undefined;
	private authorityLost: unknown;
	private runSettled = false;
	private topologyMutationInProgress = 0;
	/** FIFO transaction lane shared by every local_write Attempt in this Graph. */
	private localWriteTail: Promise<void> = Promise.resolve();

	constructor(options: V3GraphRunOptions) {
		this.options = options;
		this.baseGraph = options.baseGraph ?? options.graph;
		this.graph = options.graph;
		this.mutationState = {
			revision: 0,
			sealed: this.baseGraph.mode !== "open",
			graph: options.graph,
			cancelledTaskIds: [],
			mutations: [],
		};
		this.paths = v3RunPaths(options.runDir);
		this.eventWriter = options.eventLog ?? new V3EventWriter(this.paths.eventsPath, this.paths.eventsTruncatedPath);
		for (const node of options.graph.nodes) this.state.set(node.taskId, { attempt: 0, phase: undefined });
	}

	get maxConcurrency(): number {
		return this.options.maxConcurrency ?? this.graph.maxConcurrency;
	}

	get isStopRequested(): boolean {
		return this.stopRequested;
	}

	get isPauseRequested(): boolean {
		return this.pauseRequested;
	}

	get observedRevision(): number {
		return this.mutationState.revision;
	}

	phaseOf(taskId: string): V3NodeSchedulingStatus | undefined {
		return this.synthetic.get(taskId) ?? this.state.get(taskId)?.phase;
	}

	/** Execute a Host topology mutation through this Runner's live Supervisor capability. */
	async withMutationCapability<T>(operation: (capability: V3MutationCapability) => Promise<T>): Promise<T> {
		if (!this.runPromise) void this.run().catch(() => undefined);
		while (!this.activeLease) {
			if (this.runSettled) throw new V3RunnerCapabilityUnavailableError();
			await sleep(5);
		}
		this.topologyMutationInProgress += 1;
		try {
			return await operation(mutationCapabilityForLease(this.activeLease));
		} finally {
			this.topologyMutationInProgress -= 1;
		}
	}

	requestStop(): void {
		this.stopRequested = true;
		for (const [taskId, abort] of this.nodeAborts) {
			const binding = this.activeBindings.get(taskId);
			if (!binding) {
				abort.abort();
				continue;
			}
			if (this.childStopRequests.has(taskId)) continue;
			const request = this.stopChild(binding).finally(() => abort.abort());
			// Attach a rejection handler immediately; executeNode later awaits the
			// original promise and converts an unconfirmed stop to needs_attention.
			void request.catch(() => undefined);
			this.childStopRequests.set(taskId, request);
		}
	}

	/** Hint the local loop after durable pause intent has been committed. */
	requestPause(): void {
		if (!this.stopRequested) this.pauseRequested = true;
	}

	async run(): Promise<GraphSnapshotV3> {
		if (this.runPromise) return this.runPromise;
		this.runPromise = this.drive().finally(() => { this.runSettled = true; });
		return this.runPromise;
	}

	private async drive(): Promise<GraphSnapshotV3> {
		const lease = this.options.lease ?? await acquireV3RunLease(this.paths.leasePath, this.options.authorization.runInstanceId);
		this.activeLease = lease;
		await this.refreshTopology();
		await initializeV3RunControl(
			this.options.runDir,
			this.options.authorization.runInstanceId,
			this.baseGraph.graphId,
		);
		const heartbeat = setInterval(() => {
			void lease.refresh().catch((error) => {
				this.authorityLost = error;
				this.requestStop();
			});
		}, 5_000);
		heartbeat.unref();
		await this.event("run_started", {});
		const inFlight = new Map<string, Promise<void>>();
		for (const [taskId, action] of this.resumeActions) {
			const promise = action().finally(() => {
				inFlight.delete(taskId);
				this.nodeAborts.delete(taskId);
			});
			inFlight.set(taskId, promise);
		}
		this.resumeActions.clear();
		try {
			while (true) {
				if (this.authorityLost) throw this.authorityLost;
				await this.refreshTopology();
				const running = inFlight.size;
				const control = await readV3RunControl(this.options.runDir);
				if (control.runInstanceId !== this.options.authorization.runInstanceId || control.graphId !== this.baseGraph.graphId) {
					throw new Error("V3 durable control identity does not match the admitted run.");
				}
				if (control.desiredState === "stopped" && !this.stopRequested) this.requestStop();
				this.pauseRequested = control.desiredState === "paused" && !this.stopRequested;
				const needsAttention = [...this.state.values()].some((state) => state.terminal === "needs_attention");
				const failFastAborted = (this.options.failFast === true || this.graph.failFast === true)
					&& [...this.state.values()].some((state) => state.terminal === "failed");
				const now = Date.now();
				const ready = (this.pauseRequested || this.topologyMutationInProgress > 0 || needsAttention || failFastAborted ? [] : v3ReadyNodes(this.graph, this))
					.filter((node) => !inFlight.has(node.taskId))
					.filter((node) => !(this.state.get(node.taskId)?.retryAt !== undefined && this.state.get(node.taskId)!.retryAt! > now));
				const pending = v3PendingNodes(this.graph, this);
				if (needsAttention) {
					// Ambiguous durable evidence closes the dispatch gate for the whole
					// graph. Work already admitted may settle, but nothing new may start.
					if (running === 0) return await this.persistSnapshot("needs_attention");
					await Promise.race([...inFlight.values(), sleep(RESUME_POLL_MS)]);
					continue;
				}
				if (this.pauseRequested && running === 0 && !failFastAborted) {
					return await this.persistSnapshot("paused");
				}
				if (this.stopRequested && running === 0) {
					// Stop was requested before (or without) any in-flight node settling; mark
					// every ordinary never-started node aborted without dispatching a child.
					// Journal cancellations and pure skip/block projections remain Attempt-free.
					await this.finalizeNonStarted(false);
					break;
				}
				if (failFastAborted) {
					// Attempts already admitted into the in-flight set may finish, but a
					// terminal failure permanently closes this run's dispatch gate.
					if (running === 0) {
						// Give every still-ready node an explicit no-dispatch terminal so a
						// fresh Host projection or crash adoption cannot revive it as queued.
						await this.finalizeNonStarted(true);
						return await this.persistSnapshot("failed");
					}
					await Promise.race([...inFlight.values(), sleep(RESUME_POLL_MS)]);
					continue;
				}
				if (pending.length === 0 && running === 0) {
					if (!this.mutationState.sealed) return await this.persistSnapshot("idle");
					break;
				}
				if (ready.length === 0 && running === 0) {
					if (this.topologyMutationInProgress > 0) {
						await sleep(RESUME_POLL_MS);
						continue;
					}
					const nextRetryAt = Math.min(...[...this.state.values()].map((s) => s.retryAt ?? Infinity));
					if (nextRetryAt === Infinity) {
						if (!this.mutationState.sealed) return await this.persistSnapshot("idle");
						break;
					}
					await sleep(Math.max(0, nextRetryAt - now));
					continue;
				}
				const capacity = Math.max(0, this.maxConcurrency - running);
				const activeWriter = [...inFlight.keys()].some((taskId) => this.graph.nodes.find((node) => node.taskId === taskId)?.sideEffect === "local_write");
				let writerReserved = activeWriter;
				const selected: CompiledGraphNodeV3[] = [];
				// Let pure/read-only work use capacity first. A second writer must not
				// occupy a concurrency slot while waiting for the transaction lane.
				for (const node of [...ready].sort((left, right) => Number(left.sideEffect === "local_write") - Number(right.sideEffect === "local_write"))) {
					if (selected.length >= capacity) break;
					if (node.sideEffect === "local_write") {
						if (writerReserved) continue;
						writerReserved = true;
					}
					selected.push(node);
				}
				for (const node of selected) {
					const promise = this.executeNode(node).finally(() => {
						inFlight.delete(node.taskId);
						this.nodeAborts.delete(node.taskId);
					});
					inFlight.set(node.taskId, promise);
				}
				if (inFlight.size === 0) break;
				await Promise.race([...inFlight.values(), sleep(RESUME_POLL_MS)]);
			}
			return await this.persistSnapshot();
		} finally {
			clearInterval(heartbeat);
			this.activeLease = undefined;
			await lease.release().catch(() => undefined);
		}
	}

	/** Mark nodes that never started (after failFast abort or stop) as failed/aborted without dispatch. */
	private async finalizeNonStarted(failed: boolean): Promise<void> {
		for (const node of this.graph.nodes) {
			const current = this.state.get(node.taskId);
			if (!current || current.phase !== undefined || this.synthetic.has(node.taskId)) continue;
			const at = new Date().toISOString();
			await this.recordTerminal(node, current.attempt + 1, failed ? "failed" : "aborted", {
				failure: { kind: "internal" as V3FailureKind, message: failed ? "Graph failed fast before this node started." : "Graph was stopped before this node started.", at },
			});
		}
	}

	private async executeNode(node: CompiledGraphNodeV3): Promise<void> {
		if (node.sideEffect === "local_write") {
			await this.withLocalWriteLock(() => this.executeNodeAttempt(node));
			return;
		}
		await this.executeNodeAttempt(node);
	}

	private async executeNodeAttempt(node: CompiledGraphNodeV3): Promise<void> {
		const current = this.state.get(node.taskId)!;
		const attempt = current.attempt + 1;
		if (attempt > V3_MAX_ATTEMPTS_PER_NODE) {
			throw new V3AttemptLimitError(node.taskId, attempt);
		}
		if (!await this.beginNodeAttempt(node, attempt)) return;
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		let workspace: V3PreparedWorkspace | undefined;
		try {
			const started = await this.requireAttempt(node, attempt);
			const inputArtifacts = await this.withAttemptDeadline(started, "input artifact resolution", abort, () => this.artifactsFor(node, attempt));
			// Every child, including pure/no-scope nodes, runs inside a materialized
			// shadow workspace containing its frozen Agent plus Graph Guard contract.
			workspace = await this.withAttemptDeadline(started, "workspace preparation", abort, () => prepareV3Workspace({
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.graph.graphId,
				node,
				attempt,
				runDir: this.options.runDir,
				sourceCwd: this.options.sourceCwd,
				workspace: this.graph.workspace,
				protectedSourceRoots: this.options.protectedSourceRoots ?? [],
				artifacts: inputArtifacts,
			}));
			await this.withAttemptDeadline(started, "workspace evidence binding", abort, () => this.updateAttempt(node, attempt, {
				workspaceDigest: canonicalDigest(workspace!.evidence),
			}, false));
			if (this.options.preflightAgent) {
				await this.withAttemptDeadline(started, "agent preflight", abort, () => this.options.preflightAgent!({ agent: node.agent, cwd: this.options.sourceCwd, sessionId: this.options.sessionId }));
			} else {
				await this.withAttemptDeadline(started, "agent preflight", abort, () => v3PreflightAgent({ agent: node.agent }, this.options.sourceCwd, this.options.sessionId));
			}
			if (this.stopRequested || abort.signal.aborted) {
				throw this.failure(node, attempt, "child_stopped", "Graph stop was requested before child dispatch.");
			}
			const sessionDir = join(this.paths.sessionsDir, node.taskId);
			const capsule = await this.withAttemptDeadline(started, "dependency capsule", abort, () => this.dependencyCapsuleFor(node, attempt));
			const renderedCapsule = renderV3DependencyCapsule(capsule);
			const dispatchSpec: V3DispatchSpec = {
				agent: node.agent,
				task: renderedCapsule ? `${node.task}\n\n${renderedCapsule}` : node.task,
				cwd: workspace.workspaceCwd,
				sessionDir,
				agentScope: "project",
			};
			const requestId = this.dispatchRequestId(started);
			const requestDigest = v3DispatchRequestDigest(dispatchSpec);
			const preparedAt = new Date().toISOString();
			await this.withAttemptDeadline(started, "dispatch intent persistence", abort, () => this.updateAttempt(node, attempt, {
				dispatchIntent: { requestId, requestDigest, state: "prepared", preparedAt },
			}));
			const emittedAt = new Date().toISOString();
			await this.withAttemptDeadline(started, "dispatch emit persistence", abort, () => this.updateAttempt(node, attempt, {
				dispatchIntent: { requestId, requestDigest, state: "emitting", preparedAt, emittedAt },
			}));
			let binding;
			try {
				binding = await this.withAttemptDeadline(started, "child dispatch", abort, () => v3DispatchChild(this.options.rpc, dispatchSpec, { stableRequestId: requestId }));
			} catch (error) {
				const recovered = await this.recoverDispatch({ requestId, requestDigest, state: "emitting", preparedAt, emittedAt });
				if (!recovered) {
					if (error instanceof V3NodeFailureError && error.kind === "timeout") throw error;
					throw this.failure(node, attempt, "dispatch_unknown", `Child dispatch crossed its durable emit boundary without a recoverable identity: ${error instanceof Error ? error.message : String(error)}`);
				}
				binding = recovered;
			}
			this.activeBindings.set(node.taskId, binding);
			if (this.stopRequested) {
				const request = this.stopChild(binding).finally(() => abort.abort());
				void request.catch(() => undefined);
				this.childStopRequests.set(node.taskId, request);
			}
			await this.withAttemptDeadline(started, "dispatch binding persistence", abort, () => this.updateAttempt(node, attempt, { phase: "dispatched", dispatch: binding }));
			await this.withAttemptDeadline(started, "running state persistence", abort, () => this.updateAttempt(node, attempt, { phase: "running" }));
			const child = await this.monitorChild(node, attempt, binding, abort, started);
			this.activeBindings.delete(node.taskId);
			if (this.stopRequested) {
				await this.awaitChildStopConfirmation(node, attempt);
				await this.updateAttempt(node, attempt, { child });
				throw this.failure(node, attempt, "child_stopped", "Graph stop was requested before the child result could be accepted.");
			}
			await this.continueAfterChild(node, attempt, child, workspace, abort);
		} catch (error) {
			await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			this.activeBindings.delete(node.taskId);
			this.childStopRequests.delete(node.taskId);
			await workspace?.cleanup().catch(() => undefined);
		}
	}

	private async monitorChild(
		node: CompiledGraphNodeV3,
		attempt: number,
		binding: { asyncId: string; asyncDir: string },
		abort: AbortController,
		evidence?: V3AttemptEvidence,
	): Promise<V3ChildOutcome> {
		try {
			const current = evidence ?? await this.requireAttempt(node, attempt);
			const remaining = this.remainingAttemptMs(current, "child monitoring");
			return await v3MonitorChild(this.options.rpc, binding, {
				...(remaining === undefined ? {} : { timeoutMs: remaining }),
				signal: abort.signal,
			});
		} catch (error) {
			throw this.dispatchFailure(node, attempt, error);
		}
	}

	private async continueAfterChild(
		node: CompiledGraphNodeV3,
		attempt: number,
		child: V3ChildOutcome,
		workspace: V3PreparedWorkspace | undefined,
		abort: AbortController,
	): Promise<void> {
		const attemptEvidence = await this.requireAttempt(node, attempt);
		this.assertAttemptDeadline(attemptEvidence, "post-child processing");
		if (child.terminal !== "complete") {
			// Preserve the child outcome in evidence even when it fails the node.
			await this.updateAttempt(node, attempt, { child });
			if (child.terminal === "failed") throw this.failure(node, attempt, "task_failed", `Child run failed: ${capMessage(child.output)}`);
			if (child.terminal === "stopped") throw this.failure(node, attempt, "child_stopped", "Child run was stopped before completion.");
			throw this.failure(node, attempt, "child_paused", "Child run paused; pi-graph will not resume or duplicate it.");
		}
		await this.withAttemptDeadline(attemptEvidence, "child outcome persistence", abort, () => this.updateAttempt(node, attempt, { phase: "verifying", child }));
		if (node.sideEffect === "local_write") {
			if (!workspace) throw this.failure(node, attempt, "internal", "local_write node has no recoverable workspace.");
			const remaining = this.remainingAttemptMs(attemptEvidence, "validation");
			const validationTimeout = minDefined(this.options.validationTimeoutMs, remaining);
			const results = await this.withAttemptDeadline(attemptEvidence, "validation", abort, () => runV3Validations(node.validationCommands, workspace.workspaceCwd, {
				...(validationTimeout === undefined ? {} : { timeoutMs: validationTimeout }),
				...(this.options.streamLimitBytes === undefined ? {} : { streamLimitBytes: this.options.streamLimitBytes }),
				signal: abort.signal,
			}));
			this.assertAttemptDeadline(attemptEvidence, "workspace inspection");
			const writes = await this.withAttemptDeadline(attemptEvidence, "workspace inspection", abort, () => workspace.inspectWrites());
			const validated: V3ValidatedResult = {
				schemaVersion: 1,
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.baseGraph.graphId,
				taskId: node.taskId,
				attempt,
				validations: results,
				allPassed: results.every((result) => result.ok),
				writes,
				recordedAt: new Date().toISOString(),
			};
			const validatedDigest = await this.withAttemptDeadline(attemptEvidence, "validation evidence persistence", abort, () => this.withAuthority(() => writeV3ValidatedResult(this.options.runDir, node.taskId, attempt, validated)));
			await this.withAttemptDeadline(attemptEvidence, "verification state persistence", abort, () => this.updateAttempt(node, attempt, {
				phase: "verifying",
				verification: { allPassed: validated.allPassed, validatedResultDigest: validatedDigest, verifiedAt: validated.recordedAt },
			}));
			if (!validated.allPassed) {
				const failed = results.find((result) => !result.ok);
				throw this.failure(node, attempt, "validation", `Validation failed${failed ? `: ${failed.command}` : ""}${failed?.signal ? ` (signal ${failed.signal})` : ""}${failed?.timedOut ? " (timeout)" : ""}`);
			}
			await this.withAttemptDeadline(attemptEvidence, "applying state persistence", abort, () => this.updateAttempt(node, attempt, { phase: "applying" }));
			let applied: V3FileDigest[];
			try {
				applied = await this.withAttemptDeadline(attemptEvidence, "workspace apply", abort, () => this.withAuthority(() => workspace.apply(abort.signal)));
			} catch (error) {
				if (error instanceof V3WorkspaceConflictError) throw this.failure(node, attempt, "workspace_conflict", error.message);
				throw error;
			}
			await this.withAttemptDeadline(attemptEvidence, "apply evidence persistence", abort, () => this.updateAttempt(node, attempt, { phase: "applying", applied: { writes: applied, appliedAt: new Date().toISOString() } }));
		}
		await this.acceptNode(node, attempt, child, workspace);
	}

	private async acceptNode(node: CompiledGraphNodeV3, attempt: number, child: V3ChildOutcome, workspace: V3PreparedWorkspace | undefined): Promise<void> {
		const currentAttempt = (await readLatestV3Attempt(this.options.runDir, node.taskId))?.evidence;
		if (!currentAttempt) throw this.failure(node, attempt, "internal", "Attempt evidence disappeared before acceptance.");
		if (!currentAttempt.workspaceDigest) throw this.failure(node, attempt, "dispatch_unknown", "Attempt is not bound to its workspace evidence before acceptance.");
		this.assertAttemptDeadline(currentAttempt, "artifact publication");
		const validatedDigest = currentAttempt.verification?.validatedResultDigest ?? "";
		const method: V3AcceptanceEvidence["method"] = node.sideEffect === "local_write" ? "machine-verified" : "declared";
		// Freeze the exact terminal basis first. updatedAt participates in the digest,
		// so no generic patch helper may regenerate it after acceptance publication.
		const { acceptanceDigest: _priorAcceptanceDigest, failure: _priorFailure, ...currentBasis } = currentAttempt;
		const finalBasis = validateV3Attempt({
			...currentBasis,
			phase: "accepted",
			terminalStatus: "accepted",
			child,
			updatedAt: new Date().toISOString(),
			supervisorEpoch: this.options.supervisorEpoch,
		});
		const attemptDigest = canonicalDigest(v3AcceptedAttemptBasis(finalBasis));
		const acceptance: V3AcceptanceEvidence = {
			schemaVersion: 1,
			runInstanceId: this.options.authorization.runInstanceId,
			graphId: this.baseGraph.graphId,
			taskId: node.taskId,
			attempt,
			...(node.acceptance ? { acceptance: node.acceptance } : {}),
			method,
			verified: method === "machine-verified",
			validatedResultDigest: validatedDigest,
			attemptDigest,
			recordedAt: new Date().toISOString(),
			supervisorEpoch: this.options.supervisorEpoch,
		};
		// Publish the output first. Acceptance is terminal authority and must never
		// point at an artifact that was only buffered or partially written.
		await this.withAttemptDeadline(currentAttempt, "artifact publication", undefined, () => this.writeOutputArtifact(node, attempt, child, workspace));
		this.assertAttemptDeadline(currentAttempt, "acceptance publication");
		const acceptanceDigest = await this.withAttemptDeadline(currentAttempt, "acceptance publication", undefined, () => this.withAuthority(() => writeV3AcceptanceEvidence(this.options.runDir, node.taskId, attempt, acceptance)));
		const finalAttempt = validateV3Attempt({ ...finalBasis, acceptanceDigest });
		await this.withAttemptDeadline(currentAttempt, "terminal acceptance persistence", undefined, () => this.withAuthority(() =>
			writeV3AttemptEvidence(this.options.runDir, node.taskId, attempt, finalAttempt)));
		this.state.set(node.taskId, { attempt, phase: "accepted", terminal: "accepted" });
		await this.event("node_accepted", { taskId: node.taskId, attempt });
		await this.persistSnapshot();
	}

	private async writeOutputArtifact(node: CompiledGraphNodeV3, attempt: number, child: V3ChildOutcome, workspace: V3PreparedWorkspace | undefined): Promise<void> {
		const historyPath = join(this.paths.artifactsDir, node.taskId, `attempt-${attempt}.txt`);
		const latestPath = join(this.paths.artifactsDir, `${node.taskId}.txt`);
		const content = workspace && node.sideEffect === "local_write"
			? JSON.stringify({ taskId: node.taskId, output: child.output })
			: child.output;
		await this.withAuthority(async () => {
			await mkdir(join(this.paths.artifactsDir, node.taskId), { recursive: true });
			try {
				await createDurableFile(historyPath, content);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(historyPath, "utf8") !== content) throw error;
			}
			// The mutable convenience alias is published only after immutable history.
			await atomicWriteFile(latestPath, content);
		});
	}

	private async artifactsFor(node: CompiledGraphNodeV3, consumerAttempt?: number): Promise<Array<{ name: string; source: string }>> {
		const artifacts: Array<{ name: string; source: string }> = [];
		for (const artifactName of node.inputArtifacts) {
			const producer = this.graph.nodes.find((candidate) => candidate.outputArtifact === artifactName);
			if (!producer) continue;
			const latest = await readLatestV3Attempt(this.options.runDir, producer.taskId);
			if (!latest || latest.evidence.phase !== "accepted") {
				throw this.failure(node, consumerAttempt ?? this.state.get(node.taskId)?.attempt ?? 1, "dispatch_unknown", `Input artifact '${artifactName}' has no accepted producer Attempt.`);
			}
			const chain = await verifyV3AcceptedAttemptChain(this.options.runDir, producer.taskId, latest.attempt, {
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.baseGraph.graphId,
				method: producer.sideEffect === "local_write" ? "machine-verified" : "declared",
			});
			if (!chain.ok) {
				throw this.failure(node, consumerAttempt ?? this.state.get(node.taskId)?.attempt ?? 1, "dispatch_unknown", `Input artifact '${artifactName}' failed accepted-evidence verification: ${chain.reasons.join(" ")}`);
			}
			artifacts.push({ name: artifactName, source: chain.artifactPath });
		}
		return artifacts;
	}

	private dispatchRequestId(evidence: V3AttemptEvidence): string {
		return `pi-graph-v3-${evidence.attemptNonce}`;
	}

	private async requireAttempt(node: CompiledGraphNodeV3, attempt: number): Promise<V3AttemptEvidence> {
		const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
		if (!latest || latest.attempt !== attempt) throw this.failure(node, attempt, "internal", "Attempt evidence disappeared during execution.");
		return latest.evidence;
	}

	private assertAttemptDeadline(evidence: V3AttemptEvidence, stage: string): void {
		this.remainingAttemptMs(evidence, stage);
	}

	private remainingAttemptMs(evidence: V3AttemptEvidence, stage: string): number | undefined {
		if (!evidence.deadlineAt) return undefined;
		const remaining = Date.parse(evidence.deadlineAt) - Date.now();
		if (remaining <= 0) throw new V3AttemptDeadlineError(evidence.taskId, evidence.attempt, stage, evidence.deadlineAt);
		return remaining;
	}

	private async withAttemptDeadline<T>(
		evidence: V3AttemptEvidence,
		stage: string,
		abort: AbortController | undefined,
		operation: () => Promise<T>,
	): Promise<T> {
		const remaining = this.remainingAttemptMs(evidence, stage);
		if (remaining === undefined) return operation();
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						abort?.abort();
						reject(new V3AttemptDeadlineError(evidence.taskId, evidence.attempt, stage, evidence.deadlineAt!));
					}, remaining);
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async recoverDispatch(intent: NonNullable<V3AttemptEvidence["dispatchIntent"]>, polls = 20): Promise<NonNullable<V3AttemptEvidence["dispatch"]> | undefined> {
		for (let index = 0; index < polls; index += 1) {
			const recovered = await v3RecoverDispatchBinding(
				intent.requestId,
				intent.requestDigest,
				intent.emittedAt ?? intent.preparedAt,
			);
			if (recovered) return recovered;
			if (index < polls - 1) await sleep(50);
		}
		return undefined;
	}

	private declaredDependenciesFor(node: CompiledGraphNodeV3): string[] {
		const source = this.graph.sourceGraphSpec.nodes.find((candidate) => candidate.taskId === node.taskId);
		return source?.dependsOn ? [...source.dependsOn] : [...node.dependsOn];
	}

	private async dependencyCapsuleFor(node: CompiledGraphNodeV3, consumerAttempt?: number) {
		const dependsOn = this.declaredDependenciesFor(node);
		const states = new Map<string, { status?: string; detail?: unknown; output?: unknown }>();
		for (const taskId of dependsOn) {
			const latest = await readLatestV3Attempt(this.options.runDir, taskId);
			if (!latest) continue;
			const status = latest.evidence.phase;
			if (status === "accepted") {
				const producer = this.graph.nodes.find((candidate) => candidate.taskId === taskId);
				if (!producer) continue;
				const chain = await verifyV3AcceptedAttemptChain(this.options.runDir, taskId, latest.attempt, {
					runInstanceId: this.options.authorization.runInstanceId,
					graphId: this.baseGraph.graphId,
					method: producer.sideEffect === "local_write" ? "machine-verified" : "declared",
				});
				if (!chain.ok || !chain.attempt?.child) {
					throw this.failure(node, consumerAttempt ?? this.state.get(node.taskId)?.attempt ?? 1, "dispatch_unknown", `Dependency '${taskId}' failed accepted-evidence verification: ${chain.reasons.join(" ")}`);
				}
				states.set(taskId, { status, detail: chain.attempt.child.output });
			} else if (status === "failed") {
				if (latest.evidence.runInstanceId !== this.options.authorization.runInstanceId
					|| latest.evidence.graphId !== this.baseGraph.graphId
					|| latest.evidence.taskId !== taskId
					|| latest.evidence.attempt !== latest.attempt
					|| latest.evidence.phase !== "failed"
					|| latest.evidence.terminalStatus !== "failed") {
					throw this.failure(node, consumerAttempt ?? this.state.get(node.taskId)?.attempt ?? 1, "dispatch_unknown", `Dependency '${taskId}' failed Attempt path and payload identity disagree.`);
				}
				// A failed Attempt deliberately has no acceptance chain. Its bounded
				// child output is useful only to the matching when:failed repair branch
				// and remains explicitly untrusted data in the rendered capsule.
				states.set(taskId, { status, output: latest.evidence.child?.output ?? latest.evidence.failure?.message ?? "" });
			}
		}
		return buildV3DependencyCapsule({ dependsOn, ...(node.when ? { when: node.when } : {}) }, states);
	}

	private dispatchFailure(node: CompiledGraphNodeV3, attempt: number, error: unknown): Error {
		if (error instanceof V3DispatchError) {
			if (error.kind === "monitor_timeout") return this.failure(node, attempt, "timeout", error.message);
			if (error.kind === "monitor_unknown") return this.failure(node, attempt, "dispatch_unknown", error.message);
			return this.failure(node, attempt, "internal", error.message);
		}
		if (error instanceof Error && error.message.includes("deadline")) return this.failure(node, attempt, "timeout", error.message);
		if (error instanceof Error && error.message.includes("aborted")) return this.failure(node, attempt, "internal", error.message);
		return error instanceof Error ? error : new Error(String(error));
	}

	private failure(node: CompiledGraphNodeV3, attempt: number, kind: V3FailureKind, message: string): V3NodeFailureError {
		return new V3NodeFailureError(node.taskId, attempt, kind, message);
	}

	private async handleFailure(node: CompiledGraphNodeV3, attempt: number, error: unknown, signal: AbortSignal): Promise<void> {
		const failureError = error instanceof V3NodeFailureError
			? error
			: error instanceof V3WorkspaceConflictError
				? new V3NodeFailureError(node.taskId, attempt, "workspace_conflict", error.message)
				: new V3NodeFailureError(node.taskId, attempt, "internal", error instanceof Error ? error.message : String(error));
		const at = new Date().toISOString();
		const childEvidence = await this.childOutcomeEvidence(node, attempt);
		const terminationRequired = signal.aborted || this.stopRequested || failureError.kind === "timeout";
		if (terminationRequired) {
			try {
				await this.awaitChildStopConfirmation(node, attempt);
			} catch (stopError) {
				await this.recordTerminal(node, attempt, "needs_attention", {
					failure: {
						kind: "dispatch_unknown",
						message: `Child termination could not be confirmed: ${stopError instanceof Error ? stopError.message : String(stopError)}`,
						at,
					},
					...childEvidence,
				});
				return;
			}
		}
		if (failureError.kind === "dispatch_unknown") {
			await this.recordTerminal(node, attempt, "needs_attention", {
				failure: { kind: "dispatch_unknown", message: failureError.message, at },
				...childEvidence,
			});
			return;
		}
		if (this.stopRequested || (signal.aborted && failureError.kind !== "timeout")) {
			await this.recordTerminal(node, attempt, "aborted", {
				failure: { kind: failureError.kind, message: `Aborted: ${failureError.message}`, at },
				...childEvidence,
			});
			return;
		}
		const retryable = attempt < V3_MAX_ATTEMPTS_PER_NODE && attempt < node.retryPolicy.maxAttempts && node.retryPolicy.retryOn.includes(failureError.kind as RetryReasonV3);
		if (retryable) {
			await this.recordTerminal(node, attempt, "failed", {
				failure: { kind: failureError.kind, message: failureError.message, at },
				...childEvidence,
			});
			const backoff = node.retryPolicy.backoffMs > 0 ? node.retryPolicy.backoffMs : RETRY_BACKOFF_BASE_MS;
			const current = this.state.get(node.taskId)!;
			this.state.set(node.taskId, { ...current, attempt, phase: undefined, terminal: undefined, retryAt: Date.now() + backoff });
			return;
		}
		await this.recordTerminal(node, attempt, "failed", {
			failure: { kind: failureError.kind, message: failureError.message, at },
			...childEvidence,
		});
	}

	private async awaitChildStopConfirmation(node: CompiledGraphNodeV3, attempt: number): Promise<void> {
		const request = this.childStopRequests.get(node.taskId);
		if (request) {
			await request;
			return;
		}
		const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
		if (!latest || latest.evidence.attempt !== attempt) return;
		let binding = latest.evidence.dispatch;
		if (!binding && latest.evidence.dispatchIntent?.state === "emitting") {
			binding = await this.recoverDispatch(latest.evidence.dispatchIntent);
			if (!binding) throw new V3DispatchError("monitor_unknown", `Dispatch identity for '${node.taskId}' attempt ${attempt} could not be recovered after its emit boundary.`);
			await this.updateAttempt(node, attempt, { phase: "dispatched", dispatch: binding });
		}
		if (!binding) return;
		await this.stopChild(binding);
	}

	private stopChild(binding: { asyncId: string; asyncDir: string }): ReturnType<typeof v3StopChild> {
		return v3StopChild(this.options.rpc, binding, { timeoutMs: this.options.childStopTimeoutMs ?? 5_000 });
	}

	private async childOutcomeEvidence(node: CompiledGraphNodeV3, attempt: number): Promise<Partial<V3AttemptEvidence>> {
		const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
		if (latest && latest.evidence.attempt === attempt && latest.evidence.child) return { child: latest.evidence.child };
		return {};
	}

	private async attemptBase(node: CompiledGraphNodeV3, attempt: number): Promise<V3AttemptEvidence> {
		const now = new Date().toISOString();
		return {
			schemaVersion: 1,
			runInstanceId: this.options.authorization.runInstanceId,
			graphId: this.baseGraph.graphId,
			taskId: node.taskId,
			attempt,
			attemptNonce: randomUUID(),
			phase: "prepared",
			createdAt: now,
			updatedAt: now,
			supervisorEpoch: this.options.supervisorEpoch,
			...(node.timeoutMs === undefined ? {} : { deadlineAt: new Date(Date.now() + node.timeoutMs).toISOString() }),
		};
	}

	/**
	 * Atomically re-check dynamic topology and publish the first Attempt phase
	 * under the same Supervisor fence used by append/cancel/seal. A cancellation
	 * that wins the fence therefore leaves no Attempt; a prepared Attempt that
	 * wins makes a later cancel fail closed.
	 */
	private async beginNodeAttempt(node: CompiledGraphNodeV3, attempt: number): Promise<boolean> {
		if (attempt > V3_MAX_ATTEMPTS_PER_NODE) throw new V3AttemptLimitError(node.taskId, attempt);
		const evidence = await this.withAuthority(async () => {
			const mutation = await readV3MutationJournal(this.options.runDir, this.baseGraph);
			this.applyMutationState(mutation);
			if (this.synthetic.has(node.taskId)) return undefined;
			const effective = this.graph.nodes.find((candidate) => candidate.taskId === node.taskId);
			if (!effective || v3EvaluateNodeReadiness(effective, (taskId) => this.phaseOf(taskId)).state !== "ready") return undefined;
			const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
			if (latest && latest.evidence.attempt >= attempt) return undefined;
			const next = validateV3Attempt(await this.attemptBase(effective, attempt));
			await writeV3AttemptEvidence(this.options.runDir, node.taskId, attempt, next);
			this.state.set(node.taskId, { ...(this.state.get(node.taskId) ?? {}), attempt, phase: next.phase });
			return next;
		});
		if (!evidence) return false;
		await this.event("node_prepared", { taskId: node.taskId, attempt });
		await this.persistSnapshot();
		return true;
	}

	private async recordTerminal(node: CompiledGraphNodeV3, attempt: number, phase: V3NodePhase, extra: Partial<V3AttemptEvidence>): Promise<void> {
		const current = this.state.get(node.taskId)!;
		await this.updateAttempt(node, attempt, { ...extra, phase, terminalStatus: v3NodeTerminalOf(phase) });
		this.state.set(node.taskId, { ...current, attempt, phase, terminal: phase });
	}

	private async updateAttempt(node: CompiledGraphNodeV3, attempt: number, patch: Partial<V3AttemptEvidence>, publishSnapshot = true): Promise<V3AttemptEvidence> {
		const evidence = await this.withAuthority(async () => {
			const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
			const base = latest && latest.evidence.attempt === attempt
				? latest.evidence
				: await this.attemptBase(node, attempt);
			const next = validateV3Attempt({
				...base,
				...patch,
				phase: patch.phase ?? base.phase,
				updatedAt: new Date().toISOString(),
			});
			await writeV3AttemptEvidence(this.options.runDir, node.taskId, attempt, next);
			this.state.set(node.taskId, { ...(this.state.get(node.taskId) ?? {}), attempt, phase: next.phase });
			return next;
		});
		if (publishSnapshot) {
			await this.event(`node_${evidence.phase}`, { taskId: node.taskId, attempt });
			await this.persistSnapshot();
		}
		return evidence;
	}

	private async event(type: string, fields: Record<string, unknown>): Promise<void> {
		try {
			await this.eventWriter.append({
				at: new Date().toISOString(),
				type,
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.baseGraph.graphId,
				graphDigest: this.options.authorization.graphDigest,
				...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
				...fields,
			});
		} catch {
			// Event log failures never fail the Graph.
		}
	}

	private async persistSnapshot(projectionStatusOverride?: GraphSnapshotV3["status"]): Promise<GraphSnapshotV3> {
		const snapshot = await this.withAuthority(async () => {
			// Refresh inside the mutation fence so snapshot revision and node
			// projection cannot be published behind a committed journal mutation.
			this.applyMutationState(await readV3MutationJournal(this.options.runDir, this.baseGraph));
			const next = await buildV3SnapshotProjection({
				runDir: this.options.runDir,
				graph: this.graph,
				authorization: this.options.authorization,
				sessionId: this.options.sessionId,
				supervisorEpoch: this.options.supervisorEpoch,
				...(this.options.retryBaselines ? { retryBaselines: this.options.retryBaselines } : {}),
				...(this.stopRequested ? { stopRequested: true } : {}),
				...(projectionStatusOverride ? { projectionStatusOverride } : {}),
				...(this.baseGraph.mode === "open" ? {
					topology: this.mutationState.sealed ? "sealed" as const : "open" as const,
					revision: this.mutationState.revision,
					sealed: this.mutationState.sealed,
					cancelledTaskIds: this.mutationState.cancelledTaskIds,
					...(this.mutationState.mutations.at(-1)?.at ? { topologyUpdatedAt: this.mutationState.mutations.at(-1)!.at } : {}),
				} : {}),
			});
			await atomicWriteJson(this.paths.snapshotPath, next);
			return next;
		});
		this.options.onSnapshot?.(snapshot);
		return snapshot;
	}

	private async withAuthority<T>(mutation: () => Promise<T>): Promise<T> {
		if (this.authorityLost) throw this.authorityLost;
		const lease = this.activeLease ?? this.options.lease;
		if (!lease) {
			throw new Error("V3 authoritative mutation requires an active Supervisor lease capability.");
		}
		return lease.withFence(mutation);
	}

	private async refreshTopology(): Promise<void> {
		const read = () => readV3MutationJournal(this.options.runDir, this.baseGraph);
		const lease = this.activeLease ?? this.options.lease;
		const mutation = lease ? await lease.withFence(read) : await read();
		if (mutation.revision < this.mutationState.revision) {
			throw new Error(`V3 mutation journal revision moved backwards from ${this.mutationState.revision} to ${mutation.revision}.`);
		}
		this.applyMutationState(mutation);
	}

	private applyMutationState(mutation: V3GraphMutationState): void {
		this.mutationState = mutation;
		this.graph = mutation.graph;
		for (const node of this.graph.nodes) {
			if (!this.state.has(node.taskId)) this.state.set(node.taskId, { attempt: 0, phase: undefined });
		}
		this.synthetic = v3SyntheticNodeStatuses(
			this.graph,
			{ phaseOf: (taskId) => this.state.get(taskId)?.phase },
			new Set(mutation.cancelledTaskIds),
		);
	}

	/** Rebuild node state from persisted attempt evidence and schedule interrupted-node recovery. */
	async initializeForResume(): Promise<void> {
		const now = Date.now();
		// Host normally supplies an already-replayed graph. Read again so direct
		// Runner callers and crash recovery see the same mutation authority.
		await this.refreshTopology();
		for (const node of this.graph.nodes) {
			const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
			if (!latest) {
				const baseline = this.options.retryBaselines?.[node.taskId];
				if (baseline !== undefined && baseline !== 0) throw new Error(`V3 retry baseline for '${node.taskId}' is ${baseline}, but no Attempt exists.`);
				this.state.set(node.taskId, { attempt: 0, phase: undefined });
				continue;
			}
			const evidence = latest.evidence;
			const attempt = evidence.attempt;
			const retryBaseline = this.options.retryBaselines?.[node.taskId];
			if (retryBaseline !== undefined) {
				if (retryBaseline > attempt) throw new Error(`V3 retry baseline for '${node.taskId}' is ahead of durable Attempt ${attempt}.`);
				if (retryBaseline === attempt) {
					if (attempt >= V3_MAX_ATTEMPTS_PER_NODE) throw new V3AttemptLimitError(node.taskId, attempt + 1);
					this.state.set(node.taskId, { attempt, phase: undefined });
					continue;
				}
			}
			if (evidence.phase === "accepted") {
				const chain = await verifyV3AcceptedAttemptChain(this.options.runDir, node.taskId, attempt, {
					runInstanceId: this.options.authorization.runInstanceId,
					graphId: this.baseGraph.graphId,
					method: node.sideEffect === "local_write" ? "machine-verified" : "declared",
				});
				this.state.set(node.taskId, chain.ok
					? { attempt, phase: "accepted", terminal: "accepted" }
					: { attempt, phase: "needs_attention", terminal: "needs_attention" });
				continue;
			}
			if (evidence.phase === "needs_attention") {
				this.state.set(node.taskId, { attempt, phase: "needs_attention", terminal: "needs_attention" });
				continue;
			}
			if (evidence.phase === "aborted") {
				this.state.set(node.taskId, { attempt, phase: "aborted", terminal: "aborted" });
				continue;
			}
			if (evidence.phase === "failed") {
				if (v3RetryScheduledFor(node, evidence)) {
					this.state.set(node.taskId, { attempt, phase: undefined, retryAt: now + RETRY_BACKOFF_BASE_MS });
				} else {
					this.state.set(node.taskId, { attempt, phase: "failed", terminal: "failed" });
				}
				continue;
			}
			// Interrupted non-terminal attempt → schedule a resume continuation.
			this.state.set(node.taskId, { attempt, phase: evidence.phase });
			this.resumeActions.set(node.taskId, () => this.resumeNode(node, evidence));
		}
		this.synthetic = v3SyntheticNodeStatuses(
			this.graph,
			{ phaseOf: (taskId) => this.state.get(taskId)?.phase },
			new Set(this.mutationState.cancelledTaskIds),
		);
		for (const taskId of this.synthetic.keys()) this.resumeActions.delete(taskId);
	}

	private async resumeNode(node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<void> {
		if (node.sideEffect === "local_write") {
			await this.withLocalWriteLock(() => this.resumeNodeAttempt(node, evidence));
			return;
		}
		await this.resumeNodeAttempt(node, evidence);
	}

	private async resumeNodeAttempt(node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<void> {
		const attempt = evidence.attempt;
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		let workspace: V3PreparedWorkspace | undefined;
		try {
			this.assertAttemptDeadline(evidence, "attempt recovery");
			if (evidence.phase === "applying" || (evidence.phase === "verifying" && evidence.applied)) {
				const reopenedWorkspace = await this.withAttemptDeadline(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				workspace = reopenedWorkspace;
				await this.updateAttempt(node, attempt, { phase: "applying" });
				let applied: V3FileDigest[];
				try {
					applied = await this.withAttemptDeadline(evidence, "workspace apply recovery", abort, () => this.withAuthority(() => reopenedWorkspace.apply(abort.signal)));
				} catch (error) {
					if (error instanceof V3WorkspaceConflictError) throw this.failure(node, attempt, "workspace_conflict", error.message);
					throw error;
				}
				await this.updateAttempt(node, attempt, { phase: "applying", applied: { writes: applied, appliedAt: new Date().toISOString() } });
				await this.acceptNode(node, attempt, evidence.child ?? { terminal: "complete", output: "", completedAt: new Date().toISOString() }, workspace);
				return;
			}
			if (evidence.phase === "verifying" || (evidence.phase === "prepared" && evidence.child)) {
				if (!evidence.child) throw this.failure(node, attempt, "dispatch_unknown", "Resume found a verifying attempt without a recorded child outcome.");
				workspace = await this.withAttemptDeadline(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				await this.continueAfterChild(node, attempt, evidence.child, workspace, abort);
				return;
			}
			if (evidence.phase === "dispatched" || evidence.phase === "running") {
				if (!evidence.dispatch) throw this.failure(node, attempt, "dispatch_unknown", "Resume found a dispatched attempt without a dispatch binding.");
				this.activeBindings.set(node.taskId, evidence.dispatch);
				await this.updateAttempt(node, attempt, { phase: "running" });
				const child = await this.monitorChild(node, attempt, evidence.dispatch, abort, evidence);
				this.activeBindings.delete(node.taskId);
				workspace = await this.withAttemptDeadline(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				await this.continueAfterChild(node, attempt, child, workspace, abort);
				return;
			}
			if (evidence.phase === "prepared" && evidence.dispatchIntent) {
				workspace = await this.withAttemptDeadline(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				const capsule = await this.withAttemptDeadline(evidence, "dependency capsule recovery", abort, () => this.dependencyCapsuleFor(node, attempt));
				const renderedCapsule = renderV3DependencyCapsule(capsule);
				const spec: V3DispatchSpec = {
					agent: node.agent,
					task: renderedCapsule ? `${node.task}\n\n${renderedCapsule}` : node.task,
					cwd: workspace.workspaceCwd,
					sessionDir: join(this.paths.sessionsDir, node.taskId),
					agentScope: "project",
				};
				if (v3DispatchRequestDigest(spec) !== evidence.dispatchIntent.requestDigest) {
					throw this.failure(node, attempt, "dispatch_unknown", "Recovered dispatch parameters do not match the durable request intent.");
				}
				let binding = evidence.dispatchIntent.state === "emitting" ? await this.recoverDispatch(evidence.dispatchIntent) : undefined;
				if (!binding && evidence.dispatchIntent.state === "prepared") {
					const intent = { ...evidence.dispatchIntent, state: "emitting" as const, emittedAt: new Date().toISOString() };
					await this.updateAttempt(node, attempt, { dispatchIntent: intent });
					try {
						binding = await this.withAttemptDeadline(evidence, "child dispatch recovery", abort, () => v3DispatchChild(this.options.rpc, spec, { stableRequestId: intent.requestId }));
					} catch (error) {
						binding = await this.recoverDispatch(intent);
						if (!binding) throw this.failure(node, attempt, "dispatch_unknown", `Recovered dispatch crossed its emit boundary without a recoverable identity: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				if (!binding) throw this.failure(node, attempt, "dispatch_unknown", "Resume could not bind the Child after its durable dispatch emit boundary.");
				this.activeBindings.set(node.taskId, binding);
				await this.updateAttempt(node, attempt, { phase: "running", dispatch: binding });
				const child = await this.monitorChild(node, attempt, binding, abort, evidence);
				this.activeBindings.delete(node.taskId);
				await this.continueAfterChild(node, attempt, child, workspace, abort);
				return;
			}
			// Legacy prepared evidence lacks proof of whether dispatch crossed its boundary.
			throw this.failure(node, attempt, "dispatch_unknown", "Resume found a prepared attempt without a durable dispatch intent; refusing to blindly re-dispatch.");
		} catch (error) {
			await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			this.activeBindings.delete(node.taskId);
			await workspace?.cleanup().catch(() => undefined);
		}
	}

	private async withLocalWriteLock<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.localWriteTail;
		let release!: () => void;
		this.localWriteTail = new Promise<void>((resolvePromise) => { release = resolvePromise; });
		await previous;
		try {
			return await work();
		} finally {
			release();
		}
	}

	private async reopenWorkspaceFor(node: CompiledGraphNodeV3, attempt: number): Promise<V3PreparedWorkspace> {
		const workspaceEvidence = await this.readWorkspaceEvidence(node, attempt);
		if (!workspaceEvidence) throw this.failure(node, attempt, "dispatch_unknown", `Resume could not find workspace evidence for '${node.taskId}' attempt ${attempt}.`);
		const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
		if (!latest || latest.attempt !== attempt || !latest.evidence.workspaceDigest
			|| canonicalDigest(workspaceEvidence) !== latest.evidence.workspaceDigest) {
			throw this.failure(node, attempt, "dispatch_unknown", `Resume found workspace evidence for '${node.taskId}' that is not bound by its Attempt.`);
		}
		try {
			return await reopenV3Workspace({
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.baseGraph.graphId,
				node,
				attempt,
				runDir: this.options.runDir,
				sourceCwd: this.options.sourceCwd,
				workspaceCwd: workspaceEvidence.workspaceDir,
				kind: "shadow",
				protectedSourceRoots: this.options.protectedSourceRoots ?? [],
			});
		} catch (error) {
			throw this.failure(node, attempt, "dispatch_unknown", `Resume could not reopen the workspace for '${node.taskId}': ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async readWorkspaceEvidence(node: CompiledGraphNodeV3, attempt: number): Promise<V3WorkspaceEvidence | undefined> {
		const { readV3WorkspaceEvidence } = await import("./attempt.ts");
		return readV3WorkspaceEvidence(this.options.runDir, node.taskId, attempt);
	}
}

export class V3RunnerCapabilityUnavailableError extends Error {
	constructor() {
		super("V3 Runner released its Supervisor capability before the topology mutation began.");
		this.name = "V3RunnerCapabilityUnavailableError";
	}
}

/** Adapt a lease gate to the mutation API without recursively re-acquiring it. */
export function mutationCapabilityForLease(lease: V3LeaseHandle): V3MutationCapability {
	let insideFence = false;
	return {
		assertCurrent: () => insideFence ? undefined : lease.assertCurrent(),
		withFence: (operation) => lease.withFence(async () => {
			insideFence = true;
			try {
				return await operation();
			} finally {
				insideFence = false;
			}
		}),
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function minDefined(left: number | undefined, right: number | undefined): number | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return Math.min(left, right);
}

function capMessage(message: string): string {
	return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

export class V3NodeFailureError extends Error {
	readonly taskId: string;
	readonly attempt: number;
	readonly kind: V3FailureKind;
	constructor(taskId: string, attempt: number, kind: V3FailureKind, message: string) {
		super(message);
		this.name = "V3NodeFailureError";
		this.taskId = taskId;
		this.attempt = attempt;
		this.kind = kind;
	}
}

export class V3AttemptDeadlineError extends V3NodeFailureError {
	readonly deadlineAt: string;
	readonly stage: string;
	constructor(taskId: string, attempt: number, stage: string, deadlineAt: string) {
		super(taskId, attempt, "timeout", `Attempt deadline ${deadlineAt} expired during ${stage}.`);
		this.name = "V3AttemptDeadlineError";
		this.deadlineAt = deadlineAt;
		this.stage = stage;
	}
}

export class V3AttemptLimitError extends Error {
	readonly taskId: string;
	readonly attempted: number;
	constructor(taskId: string, attempted: number) {
		super(`Node '${taskId}' cannot start Attempt ${attempted}; the lifetime cap is ${V3_MAX_ATTEMPTS_PER_NODE}.`);
		this.name = "V3AttemptLimitError";
		this.taskId = taskId;
		this.attempted = attempted;
	}
}

export async function resumeV3GraphRun(options: V3GraphRunOptions): Promise<GraphSnapshotV3> {
	const runner = new V3GraphRunner(options);
	await runner.initializeForResume();
	return runner.run();
}
