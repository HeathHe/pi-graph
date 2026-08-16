import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SubagentRpcClient } from "./rpc.ts";
import { V3WorkspaceConflictError } from "./workspace.ts";
import { atomicWriteJson } from "./durable.ts";
import {
	readLatestV3Attempt,
	validateV3Attempt,
	v3AttemptEvidenceDigest,
	v3RunPaths,
	writeV3AcceptanceEvidence,
	writeV3AttemptEvidence,
	writeV3ValidatedResult,
} from "./attempt.ts";
import { V3DispatchError, v3MonitorChild, v3PreflightAgent, v3DispatchChild } from "./dispatch.ts";
import { V3EventWriter } from "./events.ts";
import { acquireV3RunLease, type V3LeaseHandle } from "./lease.ts";
import { buildV3SnapshotProjection } from "./projection.ts";
import { v3NodeTerminalOf, v3PendingNodes, v3ReadyNodes } from "./scheduler.ts";
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
	authorization: AuthorizationV4;
	sourceCwd: string;
	sessionId: string;
	supervisorEpoch: string;
	maxConcurrency?: number;
	validationTimeoutMs?: number;
	streamLimitBytes?: number;
	failFast?: boolean;
	protectedSourceRoots?: string[];
	signal?: AbortSignal;
	onSnapshot?: (snapshot: GraphSnapshotV3) => void;
	eventLog?: V3EventWriter;
	lease?: V3LeaseHandle;
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
	if (evidence.attempt >= node.retryPolicy.maxAttempts) return false;
	return node.retryPolicy.retryOn.includes(evidence.failure.kind as RetryReasonV3);
}

export class V3GraphRunner {
	readonly options: V3GraphRunOptions;
	readonly paths: ReturnType<typeof v3RunPaths>;
	private readonly state = new Map<string, NodeRunState>();
	private readonly nodeAborts = new Map<string, AbortController>();
	private readonly resumeActions = new Map<string, () => Promise<void>>();
	private stopRequested = false;
	private runPromise: Promise<GraphSnapshotV3> | undefined;
	private eventWriter: V3EventWriter;

	constructor(options: V3GraphRunOptions) {
		this.options = options;
		this.paths = v3RunPaths(options.runDir);
		this.eventWriter = options.eventLog ?? new V3EventWriter(this.paths.eventsPath, this.paths.eventsTruncatedPath);
		for (const node of options.graph.nodes) this.state.set(node.taskId, { attempt: 0, phase: undefined });
	}

	get maxConcurrency(): number {
		return this.options.maxConcurrency ?? this.options.graph.maxConcurrency;
	}

	get isStopRequested(): boolean {
		return this.stopRequested;
	}

	phaseOf(taskId: string): V3NodePhase | undefined {
		return this.state.get(taskId)?.phase;
	}

	requestStop(): void {
		this.stopRequested = true;
		for (const abort of this.nodeAborts.values()) abort.abort();
	}

	async run(): Promise<GraphSnapshotV3> {
		if (this.runPromise) return this.runPromise;
		this.runPromise = this.drive();
		return this.runPromise;
	}

	private async drive(): Promise<GraphSnapshotV3> {
		const lease = this.options.lease ?? await acquireV3RunLease(this.paths.leasePath, this.options.authorization.runInstanceId);
		const heartbeat = setInterval(() => { void lease.refresh().catch(() => undefined); }, 5_000);
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
				const running = inFlight.size;
				const now = Date.now();
				const ready = v3ReadyNodes(this.options.graph, this)
					.filter((node) => !(this.state.get(node.taskId)?.retryAt !== undefined && this.state.get(node.taskId)!.retryAt! > now));
				const pending = v3PendingNodes(this.options.graph, this);
				if (this.stopRequested && running === 0 && pending.length > 0) {
					// Stop was requested before (or without) any in-flight node settling; mark
					// every never-started node aborted without dispatching a child.
					await this.finalizeNonStarted(false);
					break;
				}
				const failFastAborted = this.options.failFast === true && [...this.state.values()].some((s) => s.terminal === "failed" || s.terminal === "needs_attention");
				if ((pending.length === 0 && running === 0) || (failFastAborted && running === 0)) {
					await this.finalizeNonStarted(failFastAborted);
					break;
				}
				if (ready.length === 0 && running === 0) {
					const nextRetryAt = Math.min(...[...this.state.values()].map((s) => s.retryAt ?? Infinity));
					if (nextRetryAt === Infinity) {
						await this.finalizeNonStarted(false);
						break;
					}
					await sleep(Math.max(0, nextRetryAt - now));
					continue;
				}
				const capacity = Math.max(0, this.maxConcurrency - running);
				for (const node of ready.slice(0, capacity)) {
					const promise = this.executeNode(node).finally(() => {
						inFlight.delete(node.taskId);
						this.nodeAborts.delete(node.taskId);
					});
					inFlight.set(node.taskId, promise);
				}
				if (inFlight.size === 0) break;
				await Promise.race([...inFlight.values(), sleep(RESUME_POLL_MS)]);
			}
		} finally {
			clearInterval(heartbeat);
			await lease.release().catch(() => undefined);
		}
		return this.persistSnapshot();
	}

	/** Mark nodes that never started (after failFast abort or stop) as failed/aborted without dispatch. */
	private async finalizeNonStarted(failed: boolean): Promise<void> {
		for (const node of this.options.graph.nodes) {
			const current = this.state.get(node.taskId);
			if (!current || current.phase !== undefined) continue;
			const at = new Date().toISOString();
			await this.recordTerminal(node, current.attempt + 1, failed ? "failed" : "aborted", {
				failure: { kind: "internal" as V3FailureKind, message: failed ? "Graph failed fast before this node started." : "Graph was stopped before this node started.", at },
			});
		}
	}

	private async executeNode(node: CompiledGraphNodeV3): Promise<void> {
		const current = this.state.get(node.taskId)!;
		const attempt = current.attempt + 1;
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		let workspace: V3PreparedWorkspace | undefined;
		try {
			await this.updateAttempt(node, attempt, { phase: "prepared" });
			const needsWorkspace = node.sideEffect !== "none" || node.readScope.length > 0 || node.writeScope.length > 0;
			if (needsWorkspace) {
				workspace = await prepareV3Workspace({
					runInstanceId: this.options.authorization.runInstanceId,
					graphId: this.options.graph.graphId,
					node,
					attempt,
					runDir: this.options.runDir,
					sourceCwd: this.options.sourceCwd,
					workspace: this.options.graph.workspace,
					protectedSourceRoots: this.options.protectedSourceRoots ?? [],
					artifacts: await this.artifactsFor(node),
				});
			}
			if (this.options.preflightAgent) {
				await this.options.preflightAgent({ agent: node.agent, cwd: this.options.sourceCwd, sessionId: this.options.sessionId });
			} else {
				await v3PreflightAgent({ agent: node.agent }, this.options.sourceCwd, this.options.sessionId);
			}
			const sessionDir = join(this.paths.sessionsDir, node.taskId);
			const binding = await v3DispatchChild(this.options.rpc, {
				agent: node.agent,
				task: node.task,
				cwd: workspace?.workspaceCwd ?? this.options.sourceCwd,
				sessionDir,
			});
			await this.updateAttempt(node, attempt, { phase: "dispatched", dispatch: binding });
			await this.updateAttempt(node, attempt, { phase: "running" });
			const child = await this.monitorChild(node, attempt, binding, abort);
			await this.continueAfterChild(node, attempt, child, workspace, abort);
		} catch (error) {
			await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			await workspace?.cleanup().catch(() => undefined);
		}
	}

	private async monitorChild(node: CompiledGraphNodeV3, attempt: number, binding: { asyncId: string; asyncDir: string }, abort: AbortController): Promise<V3ChildOutcome> {
		try {
			return await v3MonitorChild(this.options.rpc, binding, {
				...(node.timeoutMs === undefined ? {} : { timeoutMs: node.timeoutMs }),
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
		if (child.terminal !== "complete") {
			// Preserve the child outcome in evidence even when it fails the node.
			await this.updateAttempt(node, attempt, { child });
			if (child.terminal === "failed") throw this.failure(node, attempt, "task_failed", `Child run failed: ${capMessage(child.output)}`);
			if (child.terminal === "stopped") throw this.failure(node, attempt, "child_stopped", "Child run was stopped before completion.");
			throw this.failure(node, attempt, "child_paused", "Child run paused; pi-graph will not resume or duplicate it.");
		}
		await this.updateAttempt(node, attempt, { phase: "verifying", child });
		if (node.sideEffect === "local_write") {
			if (!workspace) throw this.failure(node, attempt, "internal", "local_write node has no recoverable workspace.");
			const results = await runV3Validations(node.validationCommands, workspace.workspaceCwd, {
				...(this.options.validationTimeoutMs === undefined ? {} : { timeoutMs: this.options.validationTimeoutMs }),
				...(this.options.streamLimitBytes === undefined ? {} : { streamLimitBytes: this.options.streamLimitBytes }),
				signal: abort.signal,
			});
			const writes = await workspace.inspectWrites();
			const validated: V3ValidatedResult = {
				schemaVersion: 1,
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.options.graph.graphId,
				taskId: node.taskId,
				attempt,
				validations: results,
				allPassed: results.every((result) => result.ok),
				writes,
				recordedAt: new Date().toISOString(),
			};
			const validatedDigest = await writeV3ValidatedResult(this.options.runDir, node.taskId, attempt, validated);
			await this.updateAttempt(node, attempt, {
				phase: "verifying",
				verification: { allPassed: validated.allPassed, validatedResultDigest: validatedDigest, verifiedAt: validated.recordedAt },
			});
			if (!validated.allPassed) {
				const failed = results.find((result) => !result.ok);
				throw this.failure(node, attempt, "validation", `Validation failed${failed ? `: ${failed.command}` : ""}${failed?.signal ? ` (signal ${failed.signal})` : ""}${failed?.timedOut ? " (timeout)" : ""}`);
			}
			await this.updateAttempt(node, attempt, { phase: "applying" });
			let applied: V3FileDigest[];
			try {
				applied = await workspace.apply(abort.signal);
			} catch (error) {
				if (error instanceof V3WorkspaceConflictError) throw this.failure(node, attempt, "workspace_conflict", error.message);
				throw error;
			}
			await this.updateAttempt(node, attempt, { phase: "applying", applied: { writes: applied, appliedAt: new Date().toISOString() } });
		}
		await this.acceptNode(node, attempt, child, workspace);
	}

	private async acceptNode(node: CompiledGraphNodeV3, attempt: number, child: V3ChildOutcome, workspace: V3PreparedWorkspace | undefined): Promise<void> {
		const currentAttempt = (await readLatestV3Attempt(this.options.runDir, node.taskId))?.evidence;
		if (!currentAttempt) throw this.failure(node, attempt, "internal", "Attempt evidence disappeared before acceptance.");
		const attemptDigest = v3AttemptEvidenceDigest(currentAttempt);
		const validatedDigest = currentAttempt.verification?.validatedResultDigest ?? "";
		const method: V3AcceptanceEvidence["method"] = node.sideEffect === "local_write" ? "machine-verified" : "declared";
		const acceptance: V3AcceptanceEvidence = {
			schemaVersion: 1,
			runInstanceId: this.options.authorization.runInstanceId,
			graphId: this.options.graph.graphId,
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
		const acceptanceDigest = await writeV3AcceptanceEvidence(this.options.runDir, node.taskId, attempt, acceptance);
		await this.writeOutputArtifact(node, child, workspace);
		await this.recordTerminal(node, attempt, "accepted", {
			child,
			...(currentAttempt.verification ? { verification: currentAttempt.verification } : {}),
			...(currentAttempt.applied ? { applied: currentAttempt.applied } : {}),
			acceptanceDigest,
		});
	}

	private async writeOutputArtifact(node: CompiledGraphNodeV3, child: V3ChildOutcome, workspace: V3PreparedWorkspace | undefined): Promise<void> {
		const artifactPath = join(this.paths.artifactsDir, node.taskId);
		await mkdir(this.paths.artifactsDir, { recursive: true });
		const content = workspace && node.sideEffect === "local_write"
			? JSON.stringify({ taskId: node.taskId, output: child.output })
			: child.output;
		await writeFile(artifactPath, content, "utf8");
	}

	private async artifactsFor(node: CompiledGraphNodeV3): Promise<Array<{ name: string; source: string }>> {
		const artifacts: Array<{ name: string; source: string }> = [];
		for (const artifactName of node.inputArtifacts) {
			const producer = this.options.graph.nodes.find((candidate) => candidate.outputArtifact === artifactName);
			if (!producer) continue;
			artifacts.push({ name: artifactName, source: join(this.paths.artifactsDir, producer.taskId) });
		}
		return artifacts;
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
		if (failureError.kind === "dispatch_unknown") {
			await this.recordTerminal(node, attempt, "needs_attention", {
				failure: { kind: "dispatch_unknown", message: failureError.message, at },
				...childEvidence,
			});
			return;
		}
		if (signal.aborted || this.stopRequested) {
			await this.recordTerminal(node, attempt, "aborted", {
				failure: { kind: failureError.kind, message: `Aborted: ${failureError.message}`, at },
				...childEvidence,
			});
			return;
		}
		const retryable = attempt < node.retryPolicy.maxAttempts && node.retryPolicy.retryOn.includes(failureError.kind as RetryReasonV3);
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
			graphId: this.options.graph.graphId,
			taskId: node.taskId,
			attempt,
			attemptNonce: randomUUID(),
			phase: "prepared",
			createdAt: now,
			updatedAt: now,
			supervisorEpoch: this.options.supervisorEpoch,
		};
	}

	private async recordTerminal(node: CompiledGraphNodeV3, attempt: number, phase: V3NodePhase, extra: Partial<V3AttemptEvidence>): Promise<void> {
		const current = this.state.get(node.taskId)!;
		await this.updateAttempt(node, attempt, { ...extra, phase, terminalStatus: v3NodeTerminalOf(phase) });
		this.state.set(node.taskId, { ...current, attempt, phase, terminal: phase });
	}

	private async updateAttempt(node: CompiledGraphNodeV3, attempt: number, patch: Partial<V3AttemptEvidence>): Promise<V3AttemptEvidence> {
		const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
		const base = latest && latest.evidence.attempt === attempt
			? latest.evidence
			: await this.attemptBase(node, attempt);
		const evidence = validateV3Attempt({
			...base,
			...patch,
			phase: patch.phase ?? base.phase,
			updatedAt: new Date().toISOString(),
		});
		await writeV3AttemptEvidence(this.options.runDir, node.taskId, attempt, evidence);
		this.state.set(node.taskId, { ...(this.state.get(node.taskId) ?? {}), attempt, phase: evidence.phase });
		await this.event(`node_${evidence.phase}`, { taskId: node.taskId, attempt });
		await this.persistSnapshot();
		return evidence;
	}

	private async event(type: string, fields: Record<string, unknown>): Promise<void> {
		try {
			await this.eventWriter.append({
				at: new Date().toISOString(),
				type,
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.options.graph.graphId,
				...(this.options.graph.graphDigest ? { graphDigest: this.options.graph.graphDigest } : {}),
				...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
				...fields,
			});
		} catch {
			// Event log failures never fail the Graph.
		}
	}

	private async persistSnapshot(): Promise<GraphSnapshotV3> {
		const snapshot = await buildV3SnapshotProjection({
			runDir: this.options.runDir,
			graph: this.options.graph,
			authorization: this.options.authorization,
			sessionId: this.options.sessionId,
			supervisorEpoch: this.options.supervisorEpoch,
			...(this.stopRequested ? { stopRequested: true } : {}),
		});
		await atomicWriteJson(this.paths.snapshotPath, snapshot);
		this.options.onSnapshot?.(snapshot);
		return snapshot;
	}

	/** Rebuild node state from persisted attempt evidence and schedule interrupted-node recovery. */
	async initializeForResume(): Promise<void> {
		const now = Date.now();
		for (const node of this.options.graph.nodes) {
			const latest = await readLatestV3Attempt(this.options.runDir, node.taskId);
			if (!latest) {
				this.state.set(node.taskId, { attempt: 0, phase: undefined });
				continue;
			}
			const evidence = latest.evidence;
			const attempt = evidence.attempt;
			if (evidence.phase === "accepted") {
				this.state.set(node.taskId, { attempt, phase: "accepted", terminal: "accepted" });
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
	}

	private async resumeNode(node: CompiledGraphNodeV3, evidence: V3AttemptEvidence): Promise<void> {
		const attempt = evidence.attempt;
		const abort = new AbortController();
		this.nodeAborts.set(node.taskId, abort);
		let workspace: V3PreparedWorkspace | undefined;
		try {
			if (evidence.phase === "applying" || (evidence.phase === "verifying" && evidence.applied)) {
				workspace = await this.reopenWorkspaceFor(node, attempt);
				await this.updateAttempt(node, attempt, { phase: "applying" });
				let applied: V3FileDigest[];
				try {
					applied = await workspace.apply(abort.signal);
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
				workspace = await this.reopenWorkspaceFor(node, attempt);
				await this.continueAfterChild(node, attempt, evidence.child, workspace, abort);
				return;
			}
			if (evidence.phase === "dispatched" || evidence.phase === "running") {
				if (!evidence.dispatch) throw this.failure(node, attempt, "dispatch_unknown", "Resume found a dispatched attempt without a dispatch binding.");
				await this.updateAttempt(node, attempt, { phase: "running" });
				const child = await this.monitorChild(node, attempt, evidence.dispatch, abort);
				workspace = await this.reopenWorkspaceFor(node, attempt);
				await this.continueAfterChild(node, attempt, child, workspace, abort);
				return;
			}
			// prepared without dispatch: cannot confirm a child was never dispatched → needs_attention.
			await this.recordTerminal(node, attempt, "needs_attention", {
				failure: { kind: "dispatch_unknown", message: "Resume found a prepared attempt with no dispatch binding; refusing to blindly re-dispatch.", at: new Date().toISOString() },
			});
		} catch (error) {
			await this.handleFailure(node, attempt, error, abort.signal);
		} finally {
			await workspace?.cleanup().catch(() => undefined);
		}
	}

	private async reopenWorkspaceFor(node: CompiledGraphNodeV3, attempt: number): Promise<V3PreparedWorkspace> {
		const workspaceEvidence = await this.readWorkspaceEvidence(node, attempt);
		if (!workspaceEvidence) throw this.failure(node, attempt, "dispatch_unknown", `Resume could not find workspace evidence for '${node.taskId}' attempt ${attempt}.`);
		try {
			return await reopenV3Workspace({
				runInstanceId: this.options.authorization.runInstanceId,
				graphId: this.options.graph.graphId,
				node,
				attempt,
				runDir: this.options.runDir,
				sourceCwd: this.options.sourceCwd,
				workspaceCwd: workspaceEvidence.workspaceDir,
				kind: workspaceEvidence.workspaceKind === "git" ? "git" : "shadow",
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

export async function resumeV3GraphRun(options: V3GraphRunOptions): Promise<GraphSnapshotV3> {
	const runner = new V3GraphRunner(options);
	await runner.initializeForResume();
	return runner.run();
}
