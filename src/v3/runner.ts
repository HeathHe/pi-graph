import { V3FallbackPauseError } from "./failure-policy.ts";
import { safeFallbackContinuation, verifyFallbackContinuation, selectedRuntimeNode, continuationProducerConstraints } from "./runtime-fallback.ts";
import { MAILBOX_BINDING_NAMESPACE } from "./mailbox-bindings.ts";
import { readNativeJson } from "./native-results.ts";
import { GraphMailbox } from "./mailbox.ts";
import { MailboxBroker } from "./mailbox-transport.ts";
import { activeMailboxes, mailboxRegistryKey } from "./mailbox-runtime.ts";
import { safeBytes, parseBusinessResult, persistEvidenceFiles, verifyEvidenceFiles, evidenceDirectory } from "./evidence-files.ts";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SubagentRpcClient } from "./rpc.ts";
import { V3WorkspaceConflictError } from "./workspace.ts";
import { atomicWriteFile, atomicWriteJson, createDurableFile } from "./durable.ts";
import { initializeV3RunControl, readV3RunControl } from "./control.ts";
import { type V3DependencyCapsuleState, buildV3DependencyCapsule, renderV3DependencyCapsule } from "./capsule.ts";
import {
	readLatestV3Attempt,
	V3_MAX_ATTEMPTS_PER_NODE,
	validateV3Attempt,
	verifyV3AcceptedAttemptChain,
	v3AcceptedAttemptBasis,
	v3RunPaths,
	v3NodeAttemptDir,
	writeV3AcceptanceEvidence,
	writeV3AttemptEvidence,
	writeV3ValidatedResult,
} from "./attempt.ts";
import { canonicalDigest } from "./digests.ts";
import { createV3DispatchObservation, v3ChildObservationFingerprint } from "./observability.ts";
import {
	V3DispatchError,
	v3DispatchChild,
	releaseV3ResultCapture,
	v3DispatchRequestDigest,
	v3GraphGuardExtensionBindings,
	v3MonitorChild,
	v3PreflightAgent,
	v3StopChild,
	type V3DispatchSpec,
} from "./dispatch.ts";
import { V3EventWriter } from "./events.ts";
import { acquireV3RunLease, type V3LeaseHandle } from "./lease.ts";
import { readV3MutationJournal, type V3GraphMutationState, type V3MutationCapability } from "./mutations.ts";
import { buildV3SnapshotProjection } from "./projection.ts";
import { v3EvaluateNodeReadiness, v3NodeTerminalOf, v3PendingNodes, v3ReadyNodes, v3SyntheticNodeStatuses, type V3NodeSchedulingStatus } from "./scheduler.ts";
import { runV3Validations } from "./verify.ts";
import { frozenContextTools, prepareV3Workspace, reopenV3Workspace, type V3PreparedWorkspace } from "./workspace.ts";
import { readV3UsageBudgetDecision } from "./usage-budget.ts";
import type { RetryReasonV3 } from "./types.ts";
import type {
	AuthorizationV4,
	CompiledGraphNodeV3,
	CompiledGraphV3,
	GraphSnapshotV3,
	V3AcceptanceEvidence,
	V3AttemptEvidence,
	V3ChildOutcome,
	V3ChildObservation,
	V3DispatchBinding,
	V3FailureKind,
	V3FileDigest,
	V3NodePhase,
	V3ValidatedResult,
	V3WorkspaceEvidence,
} from "./types.ts";

const RETRY_BACKOFF_BASE_MS = 250;
const RESUME_POLL_MS = 250;

export interface V3GraphRunOptions {
	parentToolAllowlist?: () => string[];
	rpc: SubagentRpcClient;
	runDir: string;
	graph: CompiledGraphV3;
	/** Immutable authorization source; graph may already be its effective replay. */
	baseGraph?: CompiledGraphV3;
	authorization: AuthorizationV4;
	sourceCwd: string;
	sessionId: string;
	ownerSessionFile?: string;
	supervisorEpoch: string;
	maxConcurrency?: number;
	/** Bounded confirmation window after an explicit stop request (default 5s). */
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
	if (node.resultContract) return false;
	const supervision = evidence.child?.observation?.supervision;
	// One recovery for an observed runtime crash. Provider retries belong to
	// the runtime; write effects and ambiguous execution never auto-repeat.
	return !(node.permissionPolicy === "inherited" && !node.readOnly) && evidence.failure?.kind === "task_failed" && evidence.attempt === 1
		&& (node.sideEffect === "none" || node.sideEffect === "local_read")
		&& supervision?.version === 2 && supervision.processExitConfirmed === true
		&& supervision.runtimeFailure === true && supervision.observedMutation === false
		&& supervision.runtimeRetries === 0;
}

export class V3GraphRunner {
	readonly options: V3GraphRunOptions;
	readonly paths: ReturnType<typeof v3RunPaths>;
	private readonly state = new Map<string, NodeRunState>();
	private readonly nodeAborts = new Map<string, AbortController>();
	private readonly activeBindings = new Map<string, V3DispatchBinding>();
	private readonly childStopRequests = new Map<string, Promise<unknown>>();
	private readonly observationFingerprints = new Map<string, string>();
	private readonly observationPublishedAt = new Map<string, number>();
	private readonly resumeActions = new Map<string, () => Promise<void>>();
	private readonly baseGraph: CompiledGraphV3;
	private graph: CompiledGraphV3;
	private mutationState: V3GraphMutationState;
	private synthetic = new Map<string, "skipped" | "blocked" | "cancelled">();
	private readonly isolatedAttention = new Set<string>();
	private stopRequested = false;
	private pauseRequested = false;
	private runPromise: Promise<GraphSnapshotV3> | undefined;
	private eventWriter: V3EventWriter;
	private activeLease: V3LeaseHandle | undefined;
 private mailbox?: GraphMailbox;
 private mailboxBroker?: MailboxBroker;
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
  const protocol=JSON.parse(await (await import("node:fs/promises")).readFile(join(this.options.runDir,"communication.json"),"utf8").catch(()=>"null"));
  if(protocol?.protocol!=="graph-mailbox-v1" || protocol.runInstanceId!==this.options.authorization.runInstanceId) throw new Error("Legacy communication contract: read-only inspection only; no resume or spawn.");
		const lease = this.options.lease ?? await acquireV3RunLease(this.paths.leasePath, this.options.authorization.runInstanceId);
		this.activeLease = lease;
  let heartbeat:NodeJS.Timeout|undefined;
  let heartbeatWork:Promise<void>|undefined;
  const registryKey=mailboxRegistryKey(this.options.runDir);
  try {
		await this.refreshTopology();
  this.mailbox = new GraphMailbox(this.options.runDir,lease,async (taskId,attempt)=>{const state=this.state.get(taskId);return !this.stopRequested && !this.mutationState.cancelledTaskIds.includes(taskId) && !!state && !state.terminal && (state.attempt || 1)===attempt;},(from,to)=>{const seen=new Set<string>();const depends=(id:string):boolean=>{if(id===from)return true;if(seen.has(id))return false;seen.add(id);return (this.graph.nodes.find(n=>n.taskId===id)?.dependsOn??[]).some(depends);};return to==="@parent"||!depends(to);},async(taskId,attempt)=>{
   const state=this.state.get(taskId),binding=this.activeBindings.get(taskId);
   if(this.stopRequested || this.pauseRequested || this.mutationState.cancelledTaskIds.includes(taskId) || !state || state.attempt!==attempt || state.terminal || !["dispatched","running"].includes(state.phase??"") || !binding)return false;
   const control=await readV3RunControl(this.options.runDir);
   if(control.runInstanceId!==this.options.authorization.runInstanceId||control.desiredState!=="running")return false;
   const status=await readNativeJson(join(binding.asyncDir,"status.json"),true);
   const terminal=await readNativeJson(join(binding.asyncDir,"process-terminal.json"),true);
   return status?.runId===binding.asyncId && status.state==="running" && !terminal;
  });
  await this.mailbox.initialize(this.options.authorization.runInstanceId,this.options.sessionId,this.graph.nodes.map(node=>({taskId:node.taskId,attempt:this.state.get(node.taskId)?.attempt||1})));
  this.mailboxBroker=new MailboxBroker(this.mailbox); await this.mailboxBroker.start();
  activeMailboxes.set(mailboxRegistryKey(this.options.runDir),{mailbox:this.mailbox,owner:this.options.sessionId,runInstanceId:this.options.authorization.runInstanceId,ownerSessionFile:this.options.ownerSessionFile});

		await initializeV3RunControl(
			this.options.runDir,
			this.options.authorization.runInstanceId,
			this.baseGraph.graphId,
		);
		heartbeat = setInterval(() => {
			if (heartbeatWork) return;
			heartbeatWork = lease.refresh().catch((error) => {
				this.authorityLost = error;
				this.requestStop();
			}).finally(() => { heartbeatWork = undefined; });
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
				const globalAttention = [...this.state.entries()].some(([id, state]) => state.terminal === "needs_attention" && !this.isolatedAttention.has(id));
				const failFastAborted = (this.options.failFast === true || this.graph.failFast === true)
					&& [...this.state.values()].some((state) => state.terminal === "failed");
				const now = Date.now();
				const ready = (this.pauseRequested || this.topologyMutationInProgress > 0 || globalAttention || failFastAborted ? [] : v3ReadyNodes(this.graph, this))
					.filter((node) => !inFlight.has(node.taskId))
					.filter((node) => !(this.state.get(node.taskId)?.retryAt !== undefined && this.state.get(node.taskId)!.retryAt! > now));
				const pending = v3PendingNodes(this.graph, this);
				if (needsAttention && (globalAttention || ready.length === 0)) {
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
				// A child may settle while control/topology reads are in flight.
				// Re-evaluate durable control before declaring that the run is done.
				if (inFlight.size === 0) continue;
				await Promise.race([...inFlight.values(), sleep(RESUME_POLL_MS)]);
			}
			return await this.persistSnapshot();
		} finally {
			if(heartbeat)clearInterval(heartbeat);
   // Clearing the timer does not cancel a refresh already holding the lease gate.
   // Drain it before fencing/releasing authority and returning to callers.
   await heartbeatWork;
   await this.mailboxBroker?.close().catch(()=>undefined);
   activeMailboxes.delete(registryKey);
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

	private async executeNodeAttempt(node: CompiledGraphNodeV3, resumedPrepared?: V3AttemptEvidence): Promise<void> {
		const current = this.state.get(node.taskId)!;
		const attempt = resumedPrepared?.attempt ?? current.attempt + 1;
		if (attempt > V3_MAX_ATTEMPTS_PER_NODE) {
			throw new V3AttemptLimitError(node.taskId, attempt);
		}
		if (!resumedPrepared && !await this.beginNodeAttempt(node, attempt)) return;
  await this.mailbox?.advance(node.taskId,attempt);
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		if (this.stopRequested) abort.abort();
		let workspace: V3PreparedWorkspace | undefined;
        let parked = false;
		try {
			const budgetDecision = await readV3UsageBudgetDecision(this.options.runDir, node.taskId, attempt, node.launch?.usageBudget);
			if (budgetDecision.blocked) throw this.failure(node, attempt, "usage_budget", budgetDecision.blocked.message);
			const remainingUsageBudget = budgetDecision.remaining;
			const started = await this.requireAttempt(node, attempt);
            node = await selectedRuntimeNode(this.options.runDir, node, started);
			const inputArtifacts = await this.withAttemptOperation(started, "input artifact resolution", abort, () => this.artifactsFor(node, attempt));
			// Every child, including pure/no-scope nodes, runs inside a materialized
			// shadow workspace containing its frozen Agent plus Graph Guard contract.
			workspace = await this.withAttemptOperation(started, "workspace preparation", abort, () => prepareV3Workspace({
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
			await this.withAttemptOperation(started, "workspace evidence binding", abort, () => this.updateAttempt(node, attempt, {
				workspaceDigest: canonicalDigest(workspace!.evidence),
			}, false));
			if (this.options.preflightAgent) {
				await this.withAttemptOperation(started, "agent preflight", abort, () => this.options.preflightAgent!({ agent: node.agent, cwd: workspace!.workspaceCwd, sessionId: this.options.sessionId }));
			} else {
				// Production dispatch is deliberately project-scoped to the immutable
				// Agent profile materialized inside this node's shadow workspace. User
				// and package Agents were resolved/frozen during admission; checking the
				// source workspace here would incorrectly reject those exact profiles.
				await this.withAttemptOperation(started, "agent preflight", abort, () => v3PreflightAgent({ agent: node.agent }, workspace!.workspaceCwd, this.options.sessionId));
			}
			if (this.stopRequested || abort.signal.aborted) {
				throw this.failure(node, attempt, "child_stopped", "Graph stop was requested before child dispatch.");
			}
			const sessionDir = join(this.paths.sessionsDir, node.taskId);
			const currentParentTools = this.options.parentToolAllowlist?.();
                const effectiveParentTools = node.parentToolAllowlist?.filter(tool=>currentParentTools===undefined||currentParentTools.includes(tool));
			const capsule = await this.withAttemptOperation(started, "dependency capsule", abort, () => this.dependencyCapsuleFor(node, attempt, workspace?.evidence, effectiveParentTools ?? currentParentTools));
			const renderedCapsule = renderV3DependencyCapsule(capsule);
			const requestedAgent = this.requestedAgentFor(node);
			const dispatchSpec: V3DispatchSpec = {
				agent: node.agent,
				...(requestedAgent ? { requestedAgent } : {}),
				task: `${renderedCapsule ? `${node.task}\n\n${renderedCapsule}` : node.task}${node.resultContract ? '\nFinal output MUST be exact JSON {"status":"pass"|"blocked"|"fail","reason":"..."}. If blocked, finish with blocked; do not loop requesting permission or guess authorization.' : ""}${node.evidenceFiles?.length ? `\nDeclared non-secret evidence files to produce before finishing: ${JSON.stringify(node.evidenceFiles.map(e => e.path))}` : ""}`,
				cwd: workspace.workspaceCwd,
				sessionDir,
				agentScope: "project",
				...(node.launch?.customModelDefinitions?{customModelDefinitions:node.launch.customModelDefinitions}:{}),
                ...(node.launch?.runtimeFallback?.sessionContinuationVersion===1?{ownedContinuation:{version:1,producerConstraints:await continuationProducerConstraints(this.options.runDir,node),plan:node.launch.runtimeFallback,candidateIndex:node.launch.runtimeFallback.candidates.findIndex(c=>c.resolvedModel===node.launch?.resolvedModel),controlPath:join(this.options.runDir,"control.json"),runInstanceId:this.options.authorization.runInstanceId,graphId:this.graph.graphId}}:{}),
    ...(node.launch?.requestedModel ? { requestedModel: node.launch.requestedModel } : {}),
				...(node.launch?.resolvedModel ? { resolvedModel: node.launch.resolvedModel } : {}),
				...(node.launch?.thinking === undefined ? {} : { thinking: node.launch.thinking }),
				...(node.launch?.turnBudget ? { turnBudget: node.launch.turnBudget } : {}),
				...(node.launch?.toolBudget ? { toolBudget: node.launch.toolBudget } : {}),
				...(remainingUsageBudget ? { usageBudget: remainingUsageBudget } : {}),
				extensionBindings: {...v3GraphGuardExtensionBindings(workspace.evidence), [MAILBOX_BINDING_NAMESPACE]: {socketPath:this.mailboxBroker!.socketPath,token:await this.mailbox!.capability(node.taskId,attempt)}},
				graphToolFilter: node.toolFilter?.length ? [...node.toolFilter,"graph_mailbox"] : [],
				...(effectiveParentTools === undefined ? {} : { parentToolAllowlist: effectiveParentTools }),
			};
			const requestId = this.dispatchRequestId(started);
			const requestDigest = v3DispatchRequestDigest(dispatchSpec);
			const preparedAt = new Date().toISOString();
			await this.withAttemptOperation(started, "dispatch intent persistence", abort, () => this.updateAttempt(node, attempt, {
				dispatchIntent: { requestId, requestDigest, state: "prepared", preparedAt },
			}));
			let binding;
			try {
				binding = await this.withAttemptOperation(started, "child dispatch", abort, () => v3DispatchChild(this.options.rpc, dispatchSpec, {
					resultPath: join(v3NodeAttemptDir(this.options.runDir, node.taskId, attempt), "child-result.json"),
					stableRequestId: requestId,
					beforeSpawn: async () => {
						await this.withAttemptOperation(started, "dispatch emit persistence", abort, () => this.updateAttempt(node, attempt, {
							dispatchIntent: { requestId, requestDigest, state: "emitting", preparedAt, emittedAt: new Date().toISOString() },
						}));
					},
				}));
			} catch (error) {
				if (error instanceof V3FallbackPauseError) throw error;
                if (error instanceof V3DispatchError && error.kind === "runtime_unavailable") throw this.failure(node, attempt, "internal", error.message);
				throw this.failure(node, attempt, "dispatch_unknown", `Child dispatch crossed its durable emit boundary without a durable binding: ${error instanceof Error ? error.message : String(error)}`);
			}
			binding = this.withDispatchObservation(node, binding);
			this.activeBindings.set(node.taskId, binding);
			if (this.stopRequested) {
				const request = this.stopChild(binding).finally(() => abort.abort());
				void request.catch(() => undefined);
				this.childStopRequests.set(node.taskId, request);
			}
			await this.withAttemptOperation(started, "dispatch binding persistence", abort, () => this.updateAttempt(node, attempt, { phase: "dispatched", dispatch: binding }));
			await this.withAttemptOperation(started, "running state persistence", abort, () => this.updateAttempt(node, attempt, { phase: "running" }));
			const child = await this.monitorChild(node, attempt, binding, abort, started);
			this.activeBindings.delete(node.taskId);
			if (this.stopRequested) {
				await this.awaitChildStopConfirmation(node, attempt);
				await this.updateAttempt(node, attempt, { child });
				throw this.failure(node, attempt, "child_stopped", "Graph stop was requested before the child result could be accepted.");
			}
			await this.continueAfterChild(node, attempt, child, workspace, abort);
		} catch (error) {
			if (error instanceof V3FallbackPauseError) {parked = true;}
            else await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			const activeBinding = this.activeBindings.get(node.taskId);
			if (activeBinding) await releaseV3ResultCapture(activeBinding.asyncId);
			this.activeBindings.delete(node.taskId);
			this.childStopRequests.delete(node.taskId);
			this.observationFingerprints.delete(`${node.taskId}:${attempt}`);
			this.observationPublishedAt.delete(`${node.taskId}:${attempt}`);
			if (!parked) await workspace?.cleanup().catch(() => undefined);
		}
	}

	private async monitorChild(
		node: CompiledGraphNodeV3,
		attempt: number,
		binding: V3DispatchBinding,
		abort: AbortController,
		evidence?: V3AttemptEvidence,
	): Promise<V3ChildOutcome> {
		try {
			const baseObservation = binding.observation ?? this.dispatchObservation(node, binding.asyncId, binding.dispatchedAt);
			return await v3MonitorChild(this.options.rpc, binding, {
				ownerSessionId: this.options.sessionId,
				ownerSessionFile: this.options.ownerSessionFile,
				resultPath: join(v3NodeAttemptDir(this.options.runDir, node.taskId, attempt), "child-result.json"),
				signal: abort.signal,
				baseObservation,
				onObservation: (observation) => this.publishChildObservation(node, attempt, observation),
			});
		} catch (error) {
			throw this.dispatchFailure(node, attempt, error);
		}
	}

	private dispatchObservation(node: CompiledGraphNodeV3, asyncId: string, observedAt?: string): V3ChildObservation {
		const requestedAgent = this.requestedAgentFor(node);
		return createV3DispatchObservation({
			asyncId,
			...(requestedAgent ? { requestedAgent } : {}),
			resolvedAgent: node.binding?.resolvedAgent ?? node.agent,
			...(node.launch?.customModelDefinitions?{customModelDefinitions:node.launch.customModelDefinitions}:{}),
    ...(node.launch?.requestedModel ? { requestedModel: node.launch.requestedModel } : {}),
			...(node.launch?.resolvedModel ? { resolvedModel: node.launch.resolvedModel } : {}),
			...(node.launch?.thinking === undefined ? {} : { thinking: node.launch.thinking }),
			...(observedAt ? { observedAt } : {}),
		});
	}

	private requestedAgentFor(node: CompiledGraphNodeV3): string | undefined {
		// Capability-only authoring requests a capability, not an Agent, so it has
		// no requestedAgent. A legacy exact-Agent node has no binding envelope but
		// its public `agent` value is both the requested and resolved identity.
		return node.binding?.requestedAgent ?? (node.binding ? undefined : node.agent);
	}

	private withDispatchObservation(node: CompiledGraphNodeV3, binding: V3DispatchBinding): V3DispatchBinding {
		return binding.observation ? binding : {
			...binding,
			observation: this.dispatchObservation(node, binding.asyncId, binding.dispatchedAt),
		};
	}

	private async publishChildObservation(node: CompiledGraphNodeV3, attempt: number, observation: V3ChildObservation): Promise<void> {
		const key = `${node.taskId}:${attempt}`;
		const fingerprint = v3ChildObservationFingerprint(observation);
		if (this.observationFingerprints.get(key) === fingerprint) return;
		const waitMs = 250 - (Date.now() - (this.observationPublishedAt.get(key) ?? 0));
		if (waitMs > 0) await sleep(waitMs);
		await this.updateAttempt(node, attempt, { observation }, false);
		await this.event("node_observation", { taskId: node.taskId, attempt, observation });
		await this.persistSnapshot();
		this.observationFingerprints.set(key, fingerprint);
		this.observationPublishedAt.set(key, Date.now());
	}

	private async continueAfterChild(
		node: CompiledGraphNodeV3,
		attempt: number,
		child: V3ChildOutcome,
		workspace: V3PreparedWorkspace | undefined,
		abort: AbortController,
	): Promise<void> {
		const attemptEvidence = await this.requireAttempt(node, attempt);
		this.assertCompatibleAttempt(attemptEvidence, "post-child processing");
		await this.updateAttempt(node, attempt, {child});
		if (node.evidenceFiles?.length) {
            if (!workspace) throw this.failure(node, attempt, "validation", "Declared evidence requires a workspace.");
            const digest = await this.withAttemptOperation(attemptEvidence, "evidence retention", abort, () => this.withAuthority(() => persistEvidenceFiles(this.options.runDir, node.taskId, attempt, workspace!.workspaceCwd, node.evidenceFiles!)));
            await this.updateAttempt(node, attempt, {evidenceManifestDigest: digest});
        }
		if (child.terminal !== "complete") {
			// Preserve the child outcome in evidence even when it fails the node.
			await this.updateAttempt(node, attempt, { child });
			if (child.terminal === "failed") throw this.failure(node, attempt, "task_failed", `Child run failed: ${capMessage(child.output)}`);
			if (child.terminal === "stopped") throw this.failure(node, attempt, "child_stopped", "Child run was stopped before completion.");
			throw this.failure(node, attempt, "child_paused", "Child run paused; pi-graph will not resume or duplicate it.");
		}
		await this.withAttemptOperation(attemptEvidence, "child outcome persistence", abort, () => this.updateAttempt(node, attempt, { phase: "verifying", child }));
        if (node.resultContract) {
            let result;
            try { result = parseBusinessResult(child.output); }
            catch (error) {
                await this.recordTerminal(node, attempt, "failed", {child, failure: {kind: "validation", message: String(error), at: new Date().toISOString()}});
                return;
            }
            if (result.status !== "pass") {
                await this.recordTerminal(node, attempt, "failed", {child, failure: {kind: "task_failed", message: `Business result ${result.status}: ${result.reason}`, at: new Date().toISOString()}});
                return;
            }
        }
		if (node.sideEffect === "local_write") {
			if (!workspace) throw this.failure(node, attempt, "internal", "local_write node has no recoverable workspace.");
			if (node.permissionPolicy === "inherited" && (node.readOnly || !node.parentToolAllowlist?.includes("bash") || (node.toolFilter?.length && !node.toolFilter.includes("bash")) || (this.options.parentToolAllowlist && !this.options.parentToolAllowlist().includes("bash")))) throw this.failure(node, attempt, "validation", "Shell validation is outside the current parent/Graph bash permissions.");
			const results = await this.withAttemptOperation(attemptEvidence, "validation", abort, () => runV3Validations(node.validationCommands, workspace.workspaceCwd, {
				permissionPolicy: node.permissionPolicy,
				...(this.options.streamLimitBytes === undefined ? {} : { streamLimitBytes: this.options.streamLimitBytes }),
				signal: abort.signal,
			}));
			this.assertCompatibleAttempt(attemptEvidence, "workspace inspection");
			const writes = await this.withAttemptOperation(attemptEvidence, "workspace inspection", abort, () => workspace.inspectWrites());
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
			const validatedDigest = await this.withAttemptOperation(attemptEvidence, "validation evidence persistence", abort, () => this.withAuthority(() => writeV3ValidatedResult(this.options.runDir, node.taskId, attempt, validated)));
			await this.withAttemptOperation(attemptEvidence, "verification state persistence", abort, () => this.updateAttempt(node, attempt, {
				phase: "verifying",
				verification: { allPassed: validated.allPassed, validatedResultDigest: validatedDigest, verifiedAt: validated.recordedAt },
			}));
			if (!validated.allPassed) {
				const failed = results.find((result) => !result.ok);
				throw this.failure(node, attempt, "validation", `Validation failed${failed ? `: ${failed.command}` : ""}${failed?.signal ? ` (signal ${failed.signal})` : ""}${failed?.timedOut ? " (timeout)" : ""}`);
			}
			await this.withAttemptOperation(attemptEvidence, "applying state persistence", abort, () => this.updateAttempt(node, attempt, { phase: "applying" }));
			let applied: V3FileDigest[];
			try {
				applied = await this.withAttemptOperation(attemptEvidence, "workspace apply", abort, () => this.withAuthority(() => workspace.apply(abort.signal)));
			} catch (error) {
				if (error instanceof V3WorkspaceConflictError) throw this.failure(node, attempt, "workspace_conflict", error.message);
				throw error;
			}
			await this.withAttemptOperation(attemptEvidence, "apply evidence persistence", abort, () => this.updateAttempt(node, attempt, { phase: "applying", applied: { writes: applied, appliedAt: new Date().toISOString() } }));
		}
		await this.acceptNode(node, attempt, child, workspace);
	}

	private async acceptNode(node: CompiledGraphNodeV3, attempt: number, child: V3ChildOutcome, workspace: V3PreparedWorkspace | undefined): Promise<void> {
		const currentAttempt = (await readLatestV3Attempt(this.options.runDir, node.taskId))?.evidence;
		if (!currentAttempt) throw this.failure(node, attempt, "internal", "Attempt evidence disappeared before acceptance.");
		if (!currentAttempt.workspaceDigest) throw this.failure(node, attempt, "dispatch_unknown", "Attempt is not bound to its workspace evidence before acceptance.");
		this.assertCompatibleAttempt(currentAttempt, "artifact publication");
        if (node.resultContract && parseBusinessResult(child.output).status !== "pass") throw this.failure(node, attempt, "validation", "Only explicit pass may be accepted.");
        if (node.evidenceFiles?.length) {
            if (!currentAttempt.evidenceManifestDigest) throw this.failure(node, attempt, "validation", "Declared evidence was not durably retained before acceptance.");
            await verifyEvidenceFiles(this.options.runDir, node.taskId, attempt, currentAttempt.evidenceManifestDigest);
        }
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
		await this.withAttemptOperation(currentAttempt, "artifact publication", undefined, () => this.writeOutputArtifact(node, attempt, child, workspace));
		this.assertCompatibleAttempt(currentAttempt, "acceptance publication");
		const acceptanceDigest = await this.withAttemptOperation(currentAttempt, "acceptance publication", undefined, () => this.withAuthority(() => writeV3AcceptanceEvidence(this.options.runDir, node.taskId, attempt, acceptance)));
		const finalAttempt = validateV3Attempt({ ...finalBasis, acceptanceDigest });
		await this.withAttemptOperation(currentAttempt, "terminal acceptance persistence", undefined, () => this.withAuthority(() =>
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

	private async artifactsFor(node: CompiledGraphNodeV3, consumerAttempt?: number, workspace?: V3WorkspaceEvidence, parentTools?: readonly string[]): Promise<Array<{ name: string; source: string; expectedDigest: string }>> {
		const artifacts: Array<{ name: string; source: string; expectedDigest: string }> = [];
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
			artifacts.push({ name: artifactName, source: chain.artifactPath, expectedDigest: createHash("sha256").update(chain.artifactContents!).digest("hex") });
            if (latest.evidence.evidenceManifestDigest) {
                const manifest = await verifyEvidenceFiles(this.options.runDir, producer.taskId, latest.attempt, latest.evidence.evidenceManifestDigest);
                const directory = evidenceDirectory(this.options.runDir, producer.taskId, latest.attempt);
                for (const file of manifest.files) artifacts.push({name: `${artifactName}.files/${file.path}`, source: join(directory, "files", file.path), expectedDigest: file.sha256});
            }
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

	private assertCompatibleAttempt(evidence: V3AttemptEvidence, stage: string): void {
		if (evidence.deadlineAt) throw new V3NodeFailureError(evidence.taskId, evidence.attempt, "dispatch_unknown", `Historical timed execution requires reconciliation before ${stage}; it will not be relaunched automatically.`);
	}

	private async withAttemptOperation<T>(evidence: V3AttemptEvidence, stage: string, _abort: AbortController | undefined, operation: () => Promise<T>): Promise<T> {
		this.assertCompatibleAttempt(evidence, stage);
		if (_abort?.signal.aborted || this.stopRequested) throw new Error(`Graph operation aborted before ${stage}.`);
		if (evidence.routeSelection && evidence.routeSelection.candidateIndex > 0 && !evidence.dispatch && !this.activeBindings.has(evidence.taskId)) {
            const control = await readV3RunControl(this.options.runDir);
            if (control.runInstanceId !== evidence.runInstanceId || control.desiredState === "stopped" || _abort?.signal.aborted || this.stopRequested)
                throw new Error(`Graph operation aborted before ${stage}.`);
            if (control.desiredState === "paused") throw new V3FallbackPauseError();
        }
        return operation();
	}

	private declaredDependenciesFor(node: CompiledGraphNodeV3): string[] {
		const source = this.graph.sourceGraphSpec.nodes.find((candidate) => candidate.taskId === node.taskId);
		return source?.dependsOn ? [...source.dependsOn] : [...node.dependsOn];
	}

	private async dependencyCapsuleFor(node: CompiledGraphNodeV3, consumerAttempt?: number, workspace?: V3WorkspaceEvidence, parentTools?: readonly string[]) {
		const dependsOn = this.declaredDependenciesFor(node);
		const states = new Map<string, V3DependencyCapsuleState>();
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
				let structured:Record<string,unknown>|undefined;
                if(node.dependencyInputs?.some(s=>s.from===taskId)) {
                 structured={};
                 if(producer.resultContract)Object.assign(structured,parseBusinessResult(chain.attempt.child.output));
                 if(node.dependencyInputs.some(s=>s.from===taskId&&s.field==="evidenceFiles")) {
                  if(!chain.attempt.evidenceManifestDigest || !node.inputArtifacts.includes(producer.outputArtifact))throw new Error("Typed evidenceFiles requires an accepted manifest and inputArtifacts mapping");
                  const manifest=await verifyEvidenceFiles(this.options.runDir,taskId,latest.attempt,chain.attempt.evidenceManifestDigest);
                  structured.evidenceFiles=manifest.files.map(file=>({...file,path:`.pi-graph/inputs/${producer.outputArtifact}.files/${file.path}`}));
                 }
                }
                let reference:V3DependencyCapsuleState["reference"];
                const full=chain.attempt.child.output;
                if(node.contextPolicy==="v1" && !node.dependencyInputs && !producer.resultContract && workspace
                 && (parentTools===undefined || parentTools.includes("read")) && Buffer.byteLength(full)>=4096 && node.inputArtifacts.includes(producer.outputArtifact) && !producer.outputArtifact.split("/").some((part,index,parts)=>[".git",".pi-graph",".pi-subagents"].includes(part)||(part==="agents"&&parts[index-1]===".pi"))
                 && (await frozenContextTools(this.options.runDir,node,workspace.workspaceDir)).includes("read")) {
                  const name=producer.outputArtifact,baseline=workspace.inputBaseline[name];
                  const expected=createHash("sha256").update(chain.artifactContents!).digest("hex");
                  if(baseline?.digest===expected) {
                   const bytes=await safeBytes(workspace.workspaceDir,`.pi-graph/inputs/${name}`);
                   if(createHash("sha256").update(bytes).digest("hex")!==expected)throw new Error("Dependency material changed after workspace preparation");
                   if(bytes.toString("utf8").split("\n").every(line=>Buffer.byteLength(line)<50*1024))reference={path:`.pi-graph/inputs/${name}`,sha256:expected,bytes:bytes.length,producer:taskId,attempt:latest.attempt,format:producer.sideEffect==="local_write"?"json-task-output":"text",acceptance:producer.sideEffect==="local_write"?"machine-verified":"declared"};
                  }
                }
                states.set(taskId, { status, detail: reference ? Array.from(full).slice(0,512).join("") : full, structured, ...(reference?{reference}:{}) });
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
		return buildV3DependencyCapsule({ dependsOn, ...(node.dependencyInputs===undefined?{}:{dependencyInputs:node.dependencyInputs}), ...(node.when ? { when: node.when } : {}) }, states);
	}

	private dispatchFailure(node: CompiledGraphNodeV3, attempt: number, error: unknown): Error {
		if (error instanceof V3DispatchError) {
			if (error.kind === "monitor_unknown") return this.failure(node, attempt, "dispatch_unknown", error.message);
			return this.failure(node, attempt, "internal", error.message);
		}
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
		const terminationRequired = signal.aborted || this.stopRequested;
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
		if (this.stopRequested || signal.aborted) {
			await this.recordTerminal(node, attempt, "aborted", {
				failure: { kind: failureError.kind, message: `Aborted: ${failureError.message}`, at },
				...childEvidence,
			});
			return;
		}
		const latest = await this.requireAttempt(node, attempt);
        const staticNode = this.graph.nodes.find(n => n.taskId === node.taskId)!;
        const continuation = failureError.kind === "task_failed" && attempt < V3_MAX_ATTEMPTS_PER_NODE
            ? await safeFallbackContinuation(this.options.runDir, staticNode, latest) : undefined;
        if (continuation) {
            const budget = await readV3UsageBudgetDecision(this.options.runDir, node.taskId, attempt + 1, node.launch?.usageBudget);
            const control = await readV3RunControl(this.options.runDir);
            if (!budget.blocked && !this.stopRequested && !signal.aborted && control.runInstanceId === latest.runInstanceId && control.desiredState !== "stopped") {
                await this.recordTerminal(node, attempt, "failed", {failure:{kind:failureError.kind,message:failureError.message,at}, ...childEvidence, fallbackContinuation:continuation});
                if (this.stopRequested || signal.aborted) return;
                const next = staticNode.launch!.runtimeFallback!.candidates[continuation.candidateIndex]!;
                await this.event("node_model_fallback", {taskId:node.taskId, attempt, reason:continuation.failureKind,
                    from:node.launch?.resolvedModel, to:next.resolvedModel});
                const current = this.state.get(node.taskId)!;
                this.state.set(node.taskId, {...current, attempt, phase:undefined, terminal:undefined, retryAt:Date.now()});
                return;
            }
        }
		const retryable = v3RetryScheduledFor(node, { ...latest, failure: { kind: failureError.kind, message: failureError.message, at } });
		const supervision = latest.child?.observation?.supervision;
		if (supervision?.runtimeFailure && !retryable) {
			if (supervision.processExitConfirmed) this.isolatedAttention.add(node.taskId);
			await this.recordTerminal(node, attempt, "needs_attention", { failure: { kind: failureError.kind, message: `${failureError.message} 未自动重派：${supervision.version!==2?'当前子进程协议未提供重新派发所需的恢复证明':supervision.observedMutation!==false?'无法证明此前未产生副作用':supervision.runtimeRetries!==0?'运行时重试次数缺失或非零':'当前任务或尝试不符合安全重派条件'}。请保留已完成工作并核对原结果，不要重跑原任务。`, at }, ...childEvidence });
			return;
		}
		if (retryable) {
			const budgetDecision = await readV3UsageBudgetDecision(this.options.runDir, node.taskId, attempt + 1, node.launch?.usageBudget);
			if (budgetDecision.blocked) {
				await this.recordTerminal(node, attempt, "failed", {
					failure: {
						kind: "usage_budget",
						message: `${budgetDecision.blocked.message} Automatic retry was suppressed after ${failureError.kind}: ${failureError.message}`,
						at,
					},
					...childEvidence,
				});
				return;
			}
			await this.recordTerminal(node, attempt, "failed", {
				failure: { kind: failureError.kind, message: failureError.message, at },
				...childEvidence,
			});
			const backoff = node.retryPolicy.backoffMs > 0 ? node.retryPolicy.backoffMs : RETRY_BACKOFF_BASE_MS;
			const current = this.state.get(node.taskId)!;
			this.state.set(node.taskId, { ...current, attempt, phase: undefined, terminal: undefined, retryAt: Date.now() + backoff });
			return;
		}
        const exhaustedPlan = node.launch?.runtimeFallback;
        const selectedIndex = latest.routeSelection?.candidateIndex ?? 0;
        const finalMessage = exhaustedPlan && selectedIndex === exhaustedPlan.candidates.length - 1
            ? `${failureError.message} All ${exhaustedPlan.candidates.length} admitted model candidates have been attempted; automatic fallback is exhausted.`
            : failureError.message;
		await this.recordTerminal(node, attempt, "failed", {
			failure: { kind: failureError.kind, message: finalMessage, at },
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
		const binding = latest.evidence.dispatch;
		if (!binding && latest.evidence.dispatchIntent?.state === "emitting") {
			throw new V3DispatchError("monitor_unknown", `Dispatch identity for '${node.taskId}' attempt ${attempt} was not durably bound after its emit boundary.`);
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
			const plan = effective.launch?.runtimeFallback;
            let routeSelection;
            if (plan) {
                const index = latest?.evidence.fallbackContinuation?.candidateIndex ?? latest?.evidence.routeSelection?.candidateIndex ?? 0;
                if (latest?.evidence.fallbackContinuation && !await verifyFallbackContinuation(this.options.runDir, effective, latest.evidence)) throw new Error("Fallback predecessor proof no longer verifies.");
                const control = await readV3RunControl(this.options.runDir);
                if (index > 0 && (this.stopRequested || this.pauseRequested || control.desiredState !== "running")) return undefined;
                routeSelection = {candidateIndex:index, planDigest:plan.digest};
            }
            const next = validateV3Attempt({...await this.attemptBase(effective, attempt), ...(routeSelection ? {routeSelection} : {})});
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
  await this.mailbox?.admit(this.graph.nodes.map(node=>({taskId:node.taskId,attempt:this.state.get(node.taskId)?.attempt||1})));
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
					if (evidence.dispatch && evidence.child?.observation?.supervision?.processExitConfirmed !== true) {
						this.state.set(node.taskId, { attempt, phase: "needs_attention", terminal: "needs_attention" });
						continue;
					}
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
				if (evidence.child?.observation?.supervision?.runtimeFailure && evidence.child.observation.supervision.processExitConfirmed) this.isolatedAttention.add(node.taskId);
				this.state.set(node.taskId, { attempt, phase: "needs_attention", terminal: "needs_attention" });
				continue;
			}
			if (evidence.phase === "aborted") {
				this.state.set(node.taskId, { attempt, phase: "aborted", terminal: "aborted" });
				continue;
			}
			if (evidence.phase === "failed") {
				if (await verifyFallbackContinuation(this.options.runDir, node, evidence) || v3RetryScheduledFor(node, evidence)) {
					const budgetDecision = await readV3UsageBudgetDecision(this.options.runDir, node.taskId, attempt + 1, node.launch?.usageBudget);
					this.state.set(node.taskId, budgetDecision.blocked
						? { attempt, phase: "failed", terminal: "failed" }
						: { attempt, phase: undefined, retryAt: now + RETRY_BACKOFF_BASE_MS });
				} else {
					this.state.set(node.taskId, { attempt, phase: "failed", terminal: "failed" });
				}
				continue;
			}
			// Historical timed runs remain inspectable, but cannot silently adopt a
			// new execution contract or duplicate an unconfirmed old child.
			if (evidence.deadlineAt || node.timeoutMs !== undefined) {
				this.state.set(node.taskId, { attempt, phase: "needs_attention", terminal: "needs_attention" });
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
        if (evidence.phase === "prepared" && !evidence.dispatchIntent && !evidence.dispatch && (evidence.routeSelection?.candidateIndex ?? 0) > 0) {
            await selectedRuntimeNode(this.options.runDir, node, evidence);
            await this.executeNodeAttempt(node, evidence);
            return;
        }
		const attempt = evidence.attempt;
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		if (this.stopRequested) abort.abort();
		let workspace: V3PreparedWorkspace | undefined;
        let parked = false;
		try {
			this.assertCompatibleAttempt(evidence, "attempt recovery");
            node = await selectedRuntimeNode(this.options.runDir, node, evidence);
			if (evidence.phase === "applying" || (evidence.phase === "verifying" && evidence.applied)) {
				const reopenedWorkspace = await this.withAttemptOperation(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				workspace = reopenedWorkspace;
				await this.updateAttempt(node, attempt, { phase: "applying" });
				let applied: V3FileDigest[];
				try {
					applied = await this.withAttemptOperation(evidence, "workspace apply recovery", abort, () => this.withAuthority(() => reopenedWorkspace.apply(abort.signal)));
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
				workspace = await this.withAttemptOperation(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				await this.continueAfterChild(node, attempt, evidence.child, workspace, abort);
				return;
			}
			if (evidence.phase === "dispatched" || evidence.phase === "running") {
				if (!evidence.dispatch) throw this.failure(node, attempt, "dispatch_unknown", "Resume found a dispatched attempt without a dispatch binding.");
				const binding = this.withDispatchObservation(node, evidence.dispatch);
				this.activeBindings.set(node.taskId, binding);
				await this.updateAttempt(node, attempt, { phase: "running", dispatch: binding });
				const child = await this.monitorChild(node, attempt, binding, abort, evidence);
				this.activeBindings.delete(node.taskId);
				workspace = await this.withAttemptOperation(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				await this.continueAfterChild(node, attempt, child, workspace, abort);
				return;
			}
			if (evidence.phase === "prepared" && evidence.dispatchIntent) {
				if (evidence.dispatchIntent.state === "emitting") {
					throw this.failure(node, attempt, "dispatch_unknown", "Resume found a dispatch that may have crossed its emit boundary without a durable child binding.");
				}
				const budgetDecision = await readV3UsageBudgetDecision(this.options.runDir, node.taskId, attempt, node.launch?.usageBudget);
				if (budgetDecision.blocked) {
					throw this.failure(node, attempt, "usage_budget", budgetDecision.blocked.message);
				}
				const remainingUsageBudget = budgetDecision.remaining;
				workspace = await this.withAttemptOperation(evidence, "workspace recovery", abort, () => this.reopenWorkspaceFor(node, attempt));
				const currentParentTools = this.options.parentToolAllowlist?.();
                const effectiveParentTools = node.parentToolAllowlist?.filter(tool=>currentParentTools===undefined||currentParentTools.includes(tool));
			const capsule = await this.withAttemptOperation(evidence, "dependency capsule recovery", abort, () => this.dependencyCapsuleFor(node, attempt, workspace?.evidence, effectiveParentTools ?? currentParentTools));
				const renderedCapsule = renderV3DependencyCapsule(capsule);
				const requestedAgent = this.requestedAgentFor(node);
				const spec: V3DispatchSpec = {
					agent: node.agent,
					...(requestedAgent ? { requestedAgent } : {}),
					task: `${renderedCapsule ? `${node.task}\n\n${renderedCapsule}` : node.task}${node.resultContract ? '\nFinal output MUST be exact JSON {"status":"pass"|"blocked"|"fail","reason":"..."}. If blocked, finish with blocked; do not loop requesting permission or guess authorization.' : ""}${node.evidenceFiles?.length ? `\nDeclared non-secret evidence files to produce before finishing: ${JSON.stringify(node.evidenceFiles.map(e => e.path))}` : ""}`,
					cwd: workspace.workspaceCwd,
					sessionDir: join(this.paths.sessionsDir, node.taskId),
					agentScope: "project",
					...(node.launch?.customModelDefinitions?{customModelDefinitions:node.launch.customModelDefinitions}:{}),
                ...(node.launch?.runtimeFallback?.sessionContinuationVersion===1?{ownedContinuation:{version:1,producerConstraints:await continuationProducerConstraints(this.options.runDir,node),plan:node.launch.runtimeFallback,candidateIndex:node.launch.runtimeFallback.candidates.findIndex(c=>c.resolvedModel===node.launch?.resolvedModel),controlPath:join(this.options.runDir,"control.json"),runInstanceId:this.options.authorization.runInstanceId,graphId:this.graph.graphId}}:{}),
    ...(node.launch?.requestedModel ? { requestedModel: node.launch.requestedModel } : {}),
					...(node.launch?.resolvedModel ? { resolvedModel: node.launch.resolvedModel } : {}),
					...(node.launch?.thinking === undefined ? {} : { thinking: node.launch.thinking }),
					...(node.launch?.turnBudget ? { turnBudget: node.launch.turnBudget } : {}),
					...(node.launch?.toolBudget ? { toolBudget: node.launch.toolBudget } : {}),
					...(remainingUsageBudget ? { usageBudget: remainingUsageBudget } : {}),
					extensionBindings: {...v3GraphGuardExtensionBindings(workspace.evidence), [MAILBOX_BINDING_NAMESPACE]: {socketPath:this.mailboxBroker!.socketPath,token:await this.mailbox!.capability(node.taskId,attempt)}},
				graphToolFilter: node.toolFilter?.length ? [...node.toolFilter,"graph_mailbox"] : [],
				...(effectiveParentTools === undefined ? {} : { parentToolAllowlist: effectiveParentTools }),
				};
				if (v3DispatchRequestDigest(spec) !== evidence.dispatchIntent.requestDigest) {
					throw this.failure(node, attempt, "dispatch_unknown", "Recovered dispatch parameters do not match the durable request intent.");
				}
				const intent = evidence.dispatchIntent;
				let binding;
				try {
					binding = await this.withAttemptOperation(evidence, "child dispatch recovery", abort, () => v3DispatchChild(this.options.rpc, spec, {
						resultPath: join(v3NodeAttemptDir(this.options.runDir, node.taskId, attempt), "child-result.json"),
						stableRequestId: intent.requestId,
						beforeSpawn: async () => {
							await this.withAttemptOperation(evidence, "recovered dispatch emit persistence", abort, () => this.updateAttempt(node, attempt, {
								dispatchIntent: { ...intent, state: "emitting", emittedAt: new Date().toISOString() },
							}));
						},
					}));
				} catch (error) {
					if (error instanceof V3FallbackPauseError) throw error;
                if (error instanceof V3DispatchError && error.kind === "runtime_unavailable") throw this.failure(node, attempt, "internal", error.message);
					throw this.failure(node, attempt, "dispatch_unknown", `Recovered prepared dispatch crossed its emit boundary without a durable binding: ${error instanceof Error ? error.message : String(error)}`);
				}
				binding = this.withDispatchObservation(node, binding);
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
			if (error instanceof V3FallbackPauseError) {parked = true;}
            else await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			const activeBinding = this.activeBindings.get(node.taskId);
			if (activeBinding) await releaseV3ResultCapture(activeBinding.asyncId);
			this.activeBindings.delete(node.taskId);
			this.observationFingerprints.delete(`${node.taskId}:${attempt}`);
			this.observationPublishedAt.delete(`${node.taskId}:${attempt}`);
			if (!parked) await workspace?.cleanup().catch(() => undefined);
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
