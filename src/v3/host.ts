import { reportedTotalTokens } from "./usage-summary.ts";
import { supervisionFacts } from "./observability.ts";
import { constants } from "node:fs";
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateAuthorizationV4 } from "./authorization.ts";
import { readLatestV3Attempt, v3NodeAttemptDir, v3RunPaths } from "./attempt.ts";
import { compileGraphSpecV3 } from "./compiler.ts";
import {
	initializeV3RunControl,
 readV3RunControl,
	updateV3RunControl,
	V3ControlRevisionConflictError,
	type V3ControlMutationOptions,
	type V3DesiredState,
	type V3RunControl,
} from "./control.ts";
import { v3PreflightAgent } from "./dispatch.ts";
import { graphV3Error, GraphV3Error } from "./errors.ts";
import { detectRunFormat } from "./format-detector.ts";
import { initializeV3Run } from "./initialize.ts";
import { acquireV3RunLease, readV3RunLease, validateV3RunLease, type V3LeaseHandle } from "./lease.ts";
import {
	appendV3GraphNodes,
	cancelV3GraphNodes,
	readV3MutationJournal,
	sealV3Graph,
	type V3GraphMutationState,
	type V3MutationCapability,
	type V3MutationNodeStateView,
	V3RevisionConflictError,
} from "./mutations.ts";
import { commitV3RetryIntent, latestV3RetryBaselines, pendingV3RetryBaselines } from "./retry.ts";
import { buildV3SnapshotProjection } from "./projection.ts";
import { mutationCapabilityForLease, V3GraphRunner, V3RunnerCapabilityUnavailableError } from "./runner.ts";
import { validateGraphSnapshotV3 } from "./snapshot.ts";
import { canonicalJson } from "./digests.ts";
import { resolveSourceIdentityV3 } from "./source-identity.ts";
import {
	freezeV3GraphAgents,
	removeV3OrphanAgentProfiles,
	removeV3UncommittedAgentProfiles,
	withV3AgentProfileTransaction,
} from "./workspace.ts";
import type { SubagentRpcClient } from "./rpc.ts";
import type {
	AuthorizationV4,
	CompiledGraphV3,
	GraphRuntimeStatusV3,
	GraphSnapshotV3,
	GraphNodeSpecV3,
	GraphSpecV3,
} from "./types.ts";

const TERMINAL_STATUSES: ReadonlySet<GraphRuntimeStatusV3> = new Set(["complete", "failed", "stopped", "paused", "needs_attention"]);

interface StableJsonObservation {
	value: unknown;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	contents: string;
}

function sameStableObservation(left: StableJsonObservation, right: StableJsonObservation): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size
		&& left.mtimeMs === right.mtimeMs && left.contents === right.contents;
}

async function readStableJson(path: string, label: string): Promise<StableJsonObservation> {
	const before = await lstat(path);
	if (before.isFile() && before.nlink === 0) graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} changed identity while it was opened.`);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} must be a single regular non-symbolic-link file.`);
	}
	let handle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} changed identity while it was opened.`);
		}
		const contents = await handle.readFile("utf8");
		const [finished, current] = await Promise.all([handle.stat(), lstat(path)]);
		if (finished.dev !== opened.dev || finished.ino !== opened.ino
			|| current.dev !== opened.dev || current.ino !== opened.ino
			|| finished.nlink !== 1 || current.nlink !== 1
			|| finished.size !== opened.size || finished.mtimeMs !== opened.mtimeMs) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} changed while it was read.`);
		}
		let value: unknown;
		try {
			value = JSON.parse(contents) as unknown;
		} catch (error) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} is not valid JSON.`, { cause: error });
		}
		return { value, dev: finished.dev, ino: finished.ino, size: finished.size, mtimeMs: finished.mtimeMs, contents };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ELOOP") graphV3Error("RUN_NEEDS_ATTENTION", `V3 ${label} became a symbolic link while it was opened.`);
		throw error;
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

/** snapshot.json is a mutable rebuildable cache; tolerate an atomic publication
 * that wins the read race, while still rejecting links and unstable contents. */
async function readStableSnapshot(path: string, attempts = 5): Promise<StableJsonObservation> {
	let lastError: unknown;
	for (let attempt = 0; attempt < attempts; attempt += 1) {
		try {
			return await readStableJson(path, "snapshot.json");
		} catch (error) {
			lastError = error;
			const retryable = error instanceof GraphV3Error
				&& error.code === "RUN_NEEDS_ATTENTION"
				&& (error.message.includes("changed identity") || error.message.includes("changed while it was read"));
			if (!retryable || attempt === attempts - 1) throw error;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
		}
	}
	throw lastError;
}

export interface V3HostContext {
	parentToolAllowlist?: () => string[];
	rpc: SubagentRpcClient;
	runsDir: string;
	sessionId: string;
	ownerSessionFile?: string;
	supervisorEpoch: string;
	/** Observe every authoritative snapshot publication. */
	onStateChange?: (snapshot: GraphSnapshotV3) => void;
	/** Notify integrations only after the process-local active-work set changes. */
	onActiveWorkChange?: (items: readonly { id: string; sessionId: string }[]) => void;
	/** Injectable agent preflight; defaults to pi-subagents public preflight. */
	preflightAgent?: (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void>;
}

export interface V3GraphSummary {
	graphId: string;
	runDir: string;
	snapshot: GraphSnapshotV3;
	supervised: boolean;
}

export interface V3DoctorIssue {
	kind: "stale-lease" | "orphan-shadow" | "invalid-run" | "needs-attention";
	runId?: string;
	detail: string;
}

export interface V3DoctorReport {
	issues: V3DoctorIssue[];
	supervised: string[];
}

export interface V3StartResult {
	graph: CompiledGraphV3;
	runDir: string;
	graphId: string;
	snapshot: GraphSnapshotV3;
}

/**
 * Process-local facade for a durable V3 run. Control methods acknowledge once
 * control.json has been committed; use wait() when terminal execution evidence
 * is required. A handle remains useful after its original Supervisor exits.
 */
export class V3GraphRunHandle implements V3StartResult {
	readonly graph: CompiledGraphV3;
	readonly runDir: string;
	readonly graphId: string;
	readonly snapshot: GraphSnapshotV3;
	private readonly host: V3GraphHost;

	constructor(host: V3GraphHost, result: V3StartResult) {
		this.host = host;
		this.graph = result.graph;
		this.runDir = result.runDir;
		this.graphId = result.graphId;
		this.snapshot = result.snapshot;
	}

	status(): Promise<GraphSnapshotV3> {
		return this.host.status(this.graphId);
	}

	wait(): Promise<GraphSnapshotV3> {
		return this.host.waitForCompletion(this.graphId);
	}

	control(): Promise<V3RunControl> {
		return this.host.control(this.graphId);
	}

	stop(options: V3ControlMutationOptions = {}): Promise<V3RunControl> {
		return this.host.requestDesiredState(this.graphId, "stopped", options);
	}

	pause(options: V3ControlMutationOptions = {}): Promise<V3RunControl> {
		return this.host.requestDesiredState(this.graphId, "paused", options);
	}

	resume(options: V3ControlMutationOptions = {}): Promise<V3RunControl> {
		return this.host.requestDesiredState(this.graphId, "running", options);
	}
}

export interface LoadedV3Run {
	/** Immutable admission authority used to validate the mutation journal. */
	baseGraph: CompiledGraphV3;
	/** Effective graph rebuilt from baseGraph plus every committed mutation. */
	graph: CompiledGraphV3;
	mutation: V3GraphMutationState;
	authorization: AuthorizationV4;
	runDir: string;
}

/**
 * Production-facing V3 adapter. Owns the runs directory and the set of runs this
 * process supervises. Every operation re-verifies the run on site (format, digest,
 * lease, source identity) instead of trusting persisted integrity markers.
 */
export class V3GraphHost {
	private readonly supervised = new Map<string, { runner: V3GraphRunner; promise: Promise<GraphSnapshotV3>; ownerSessionId: string }>();
	private readonly supervisorHandoffContinuations = new Map<string, Set<Promise<void>>>();
	private readonly supervisorHandoffFailures = new Map<string, unknown>();
	private readonly supervisorHandoffs = new Map<string, Map<symbol, string>>();
	private activeWorkFingerprint = "[]";
	readonly context: V3HostContext;

	constructor(context: V3HostContext) {
		this.context = context;
	}

	/** Re-point the host at a new session (used on session_start). */
	setSessionContext(sessionId: string, supervisorEpoch: string, ownerSessionFile?: string): void {
		this.context.sessionId = sessionId;
		this.context.ownerSessionFile = ownerSessionFile;
		this.context.supervisorEpoch = supervisorEpoch;
	}

	/**
	 * Session shutdown is recoverable: commit paused intent for every supervised
	 * run before nudging local loops to quiesce. It must not convert pending work
	 * into aborted Attempts merely because the owning Pi session closed.
	 */
	async suspendAll(): Promise<V3RunControl[]> {
		const entries = [...this.supervised.entries()];
		return Promise.all(entries.map(async ([graphId, supervised]) => {
			const control = await this.requestDesiredState(graphId, "paused");
			supervised.runner.requestPause();
			return control;
		}));
	}

	get runsDir(): string {
		return resolve(this.context.runsDir);
	}

	runDirFor(graphId: string): string {
		return join(this.runsDir, graphId);
	}

	private preflight(): (spec: { agent: string; cwd: string; sessionId?: string }) => Promise<void> {
		return this.context.preflightAgent ?? ((spec) => v3PreflightAgent({ agent: spec.agent }, spec.cwd, spec.sessionId));
	}

	private runnerOptions(runDir: string, graph: CompiledGraphV3, authorization: AuthorizationV4, sourceCwd: string, baseGraph = graph): ConstructorParameters<typeof V3GraphRunner>[0] {
		return {
			rpc: this.context.rpc,
			parentToolAllowlist: this.context.parentToolAllowlist,
			runDir,
			graph,
			baseGraph,
			authorization,
			sourceCwd,
			sessionId: authorization.sessionId,
			ownerSessionFile: authorization.sessionId === this.context.sessionId ? this.context.ownerSessionFile : undefined,
			supervisorEpoch: authorization.supervisorEpoch,
			failFast: graph.failFast,
			preflightAgent: this.preflight(),
			...(this.context.onStateChange ? { onSnapshot: this.context.onStateChange } : {}),
		};
	}

	private notifyActiveWorkChange(): void {
		const items = this.listActiveWork();
		const fingerprint = JSON.stringify(items
			.map((item) => [item.sessionId, item.id] as const)
			.sort((left, right) => left[0] === right[0]
				? left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0
				: left[0] < right[0] ? -1 : 1));
		if (fingerprint === this.activeWorkFingerprint) return;
		try {
			this.context.onActiveWorkChange?.(items);
			this.activeWorkFingerprint = fingerprint;
		} catch {
			// Background-work notification is observational and cannot fail Graph execution.
		}
	}

	/** Keep one provider identity visible while a paused Supervisor hands off to its successor. */
	private reserveSupervisorHandoff(graphId: string): symbol {
		const token = Symbol(graphId);
		const reservations = this.supervisorHandoffs.get(graphId) ?? new Map<symbol, string>();
		reservations.set(token, this.context.sessionId);
		this.supervisorHandoffs.set(graphId, reservations);
		this.notifyActiveWorkChange();
		return token;
	}

	private releaseSupervisorHandoff(graphId: string, token: symbol): void {
		const reservations = this.supervisorHandoffs.get(graphId);
		if (!reservations?.delete(token)) return;
		if (reservations.size === 0) this.supervisorHandoffs.delete(graphId);
		this.notifyActiveWorkChange();
	}

	private supervise(graphId: string, runner: V3GraphRunner): Promise<GraphSnapshotV3> {
		const promise = runner.run();
		// Background work belongs to the Pi session that started/adopted this
		// Supervisor, not the immutable session recorded at original admission.
		this.supervised.set(graphId, { runner, promise, ownerSessionId: this.context.sessionId });
		this.notifyActiveWorkChange();
		void promise.finally(() => {
			if (this.supervised.get(graphId)?.promise === promise) {
				this.supervised.delete(graphId);
				this.notifyActiveWorkChange();
			}
		}).catch(() => undefined);
		return promise;
	}

	private async superviseResumedRun(
		graphId: string,
		runDir: string,
		graph: CompiledGraphV3,
		authorization: AuthorizationV4,
	): Promise<void> {
		const alreadySupervised = this.supervised.get(graphId);
		if (alreadySupervised) return;
		const baseGraph = compileGraphSpecV3(authorization.sourceGraphSpec, { historical: true });
		const retryMutation = await readV3MutationJournal(runDir, baseGraph);
		const retryBaselines = await pendingV3RetryBaselines(
			runDir,
			authorization.runInstanceId,
			graph.graphId,
			graph,
			retryMutation.cancelledTaskIds,
		);
		const runner = new V3GraphRunner({
			...this.runnerOptions(runDir, graph, authorization, authorization.sourceCwd, baseGraph),
			...(retryBaselines ? { retryBaselines } : {}),
		});
		await runner.initializeForResume();
		const raced = this.supervised.get(graphId);
		if (raced) return;
		this.supervise(graphId, runner);
	}

	private dynamicProjection(mutation: V3GraphMutationState): Pick<Parameters<typeof buildV3SnapshotProjection>[0], "topology" | "revision" | "sealed" | "cancelledTaskIds" | "topologyUpdatedAt"> {
		if (mutation.graph.mode !== "open") return {};
		return {
			topology: mutation.sealed ? "sealed" : "open",
			revision: mutation.revision,
			sealed: mutation.sealed,
			cancelledTaskIds: mutation.cancelledTaskIds,
			...(mutation.mutations.at(-1)?.at ? { topologyUpdatedAt: mutation.mutations.at(-1)!.at } : {}),
		};
	}

	private continueAfterPausedSupervisor(
		graphId: string,
		runDir: string,
		graph: CompiledGraphV3,
		authorization: AuthorizationV4,
		promise: Promise<GraphSnapshotV3>,
		handoff: symbol,
	): void {
		const continuation = (async () => {
			try {
				const snapshot = await promise;
				if (snapshot.status !== "paused" || this.supervised.has(graphId)) return;
				const latestControl = await initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId);
				if (latestControl.desiredState === "running") {
					await this.superviseResumedRun(graphId, runDir, graph, authorization);
				}
			} finally {
				this.releaseSupervisorHandoff(graphId, handoff);
			}
		})().catch((error) => {
			this.supervisorHandoffFailures.set(graphId, error);
			throw error;
		});
		const pending = this.supervisorHandoffContinuations.get(graphId) ?? new Set<Promise<void>>();
		pending.add(continuation);
		this.supervisorHandoffContinuations.set(graphId, pending);
		void continuation.finally(() => {
			pending.delete(continuation);
			if (!pending.size) this.supervisorHandoffContinuations.delete(graphId);
		}).catch(() => undefined);
	}

	private async withTopologySupervisor<T>(
		graphId: string,
		runDir: string,
		authorization: AuthorizationV4,
		operation: (capability: V3MutationCapability) => Promise<T>,
	): Promise<T> {
		const supervised = this.supervised.get(graphId);
		if (supervised) {
			try {
				return await supervised.runner.withMutationCapability(operation);
			} catch (error) {
				const releasedDuringQuiescence = error instanceof V3RunnerCapabilityUnavailableError
					|| (error instanceof GraphV3Error && error.code === "RUN_NEEDS_ATTENTION");
				if (!releasedDuringQuiescence) throw error;
				// The process-local entry can briefly outlive its lease while the idle
				// promise/finally callbacks drain. Wait for that exact Runner before
				// acquiring a fresh standalone capability; a genuinely live competing
				// process will still be rejected by acquireV3RunLease below.
				await supervised.promise.catch(() => undefined);
				await Promise.resolve();
			}
		}
		const lease = await acquireV3RunLease(v3RunPaths(runDir).leasePath, authorization.runInstanceId);
		try {
			return await operation(mutationCapabilityForLease(lease));
		} finally {
			await lease.release();
		}
	}

	private async wakeAfterTopologyMutation(graphId: string, resumeQuiescentStop = false): Promise<void> {
		// A live Supervisor owns either ordinary execution or an in-progress stop.
		// In particular, seal must not turn an active durable stop back into running.
		if (this.supervised.has(graphId)) return;
		const runDir = this.runDirFor(graphId);
		const { baseGraph, graph, authorization } = await this.loadRun(runDir, graphId);
		let control = await initializeV3RunControl(runDir, authorization.runInstanceId, graphId);
		if (resumeQuiescentStop && control.desiredState === "stopped") {
			// Only terminal evidence that seal can project as complete/failed may
			// supersede the quiescent OPEN stop. Queued/running/aborted evidence is
			// a real stop boundary and must remain stopped.
			const sealedProjection = await this.status(graphId);
			if (sealedProjection.status !== "complete" && sealedProjection.status !== "failed") return;
			try {
				control = await updateV3RunControl(runDir, "running", {
					expectedRevision: control.revision,
					runInstanceId: authorization.runInstanceId,
					graphId,
				});
			} catch (error) {
				if (!(error instanceof V3ControlRevisionConflictError)) throw error;
				// A concurrent explicit pause/stop/resume command wins over seal's
				// quiescent-stop transition. Reload it instead of overwriting intent.
				control = await initializeV3RunControl(runDir, authorization.runInstanceId, graphId);
			}
		}
		if (control.desiredState !== "running") return;
		const runner = new V3GraphRunner(this.runnerOptions(runDir, graph, authorization, authorization.sourceCwd, baseGraph));
		await runner.initializeForResume();
		if (!this.supervised.has(graphId)) this.supervise(graphId, runner);
	}

	/** Append immutable nodes under revision CAS and wake an idle OPEN graph. */
 private async hasMailboxProtocol(runDir:string,runInstanceId?:string):Promise<boolean>{try{const record=(await readStableJson(join(runDir,"communication.json"),"communication.json")).value as {protocol?:unknown;runtimeKind?:unknown;runInstanceId?:unknown};return record.protocol==="graph-mailbox-v1" && record.runtimeKind==="pi-graph-sdk/1" && (!runInstanceId||record.runInstanceId===runInstanceId);}catch{return false;}}
 private async requireMailboxProtocol(graphId:string):Promise<void>{const runDir=this.runDirFor(graphId);const {authorization}=await this.loadRun(runDir,graphId);if(!await this.hasMailboxProtocol(runDir,authorization.runInstanceId))throw new Error("Legacy communication contract: read-only inspection only; create an explicit remaining-work graph.");}
	async append(graphId: string, nodes: readonly GraphNodeSpecV3[], expectedRevision: number): Promise<V3GraphMutationState> {
  await this.requireMailboxProtocol(graphId);
		const runDir = this.runDirFor(graphId);
		const { baseGraph, authorization } = await this.loadRun(runDir, graphId);
		const state = await this.withTopologySupervisor(graphId, runDir, authorization, async (capability) =>
			withV3AgentProfileTransaction(runDir, async () => {
				const mutation = await readV3MutationJournal(runDir, baseGraph);
				if (mutation.revision !== expectedRevision) throw new V3RevisionConflictError(expectedRevision, mutation.revision);
				// Compile before freezing so invalid topology cannot leave profile files.
				const candidate = compileGraphSpecV3({
					...mutation.graph.sourceGraphSpec,
					graphId: baseGraph.graphId,
					mode: "open",
					nodes: [...mutation.graph.sourceGraphSpec.nodes, ...nodes],
				});
				const appendedIds = new Set(nodes.map((node) => node.taskId));
				const appended = candidate.nodes.filter((node) => appendedIds.has(node.taskId));
				// A prior process may have died after freezing profiles but before its
				// append revision became authority. Under the mutation lease these
				// task IDs are proven absent, so the stale reservation can be replaced.
				if (!this.context.preflightAgent) await removeV3OrphanAgentProfiles(runDir, appended);
				const frozenProfiles = !this.context.preflightAgent
					? await freezeV3GraphAgents(runDir, authorization.sourceCwd, appended)
					: [];
				try {
					return await appendV3GraphNodes({ runDir, baseGraph, nodes, expectedRevision, capability });
				} catch (error) {
					if (frozenProfiles.length > 0) {
						// A failure may occur after the no-replace journal publish boundary.
						// Preserve every profile whose node actually became authority and
						// remove only this transaction's otherwise-uncommitted profiles.
						const committed = await readV3MutationJournal(runDir, baseGraph);
						const committedTaskIds = new Set(committed.graph.nodes.map((node) => node.taskId));
						const abandoned = frozenProfiles.filter((profile) => !committedTaskIds.has(profile.taskId));
						await removeV3UncommittedAgentProfiles(runDir, abandoned);
					}
					throw error;
				}
			}),
		);
		await this.wakeAfterTopologyMutation(graphId);
		return state;
	}

	/** Tombstone pending nodes. Cancellation is projection authority and creates no Attempt. */
	async cancel(graphId: string, taskIds: readonly string[], cascade: boolean, expectedRevision: number): Promise<V3GraphMutationState> {
  await this.requireMailboxProtocol(graphId);
		const runDir = this.runDirFor(graphId);
		const { baseGraph, authorization } = await this.loadRun(runDir, graphId);
		const state = await this.withTopologySupervisor(graphId, runDir, authorization, async (capability) => {
			// cancelV3GraphNodes invokes this view inside capability.withFence, so
			// the status authority is read in the same transaction as publication.
			const view: V3MutationNodeStateView = {
				phaseOf: async (taskId) => (await readLatestV3Attempt(runDir, taskId))?.evidence.phase,
			};
			return cancelV3GraphNodes({ runDir, baseGraph, taskIds, cascade, expectedRevision, view, capability });
		});
		await this.wakeAfterTopologyMutation(graphId);
		return state;
	}

	/**
	 * Retry one terminal node and every non-cancelled descendant. The immutable
	 * intent records each node's latest Attempt baseline under a live Supervisor
	 * fence; recovery only resets nodes still at that exact baseline.
	 */
	async retry(graphId: string, taskId: string): Promise<GraphSnapshotV3> {
  await this.requireMailboxProtocol(graphId);
		if (this.supervised.has(graphId)) {
			graphV3Error("INVALID_MUTATION", `V3 graph '${graphId}' is still supervised; retry is allowed only after the run is terminal.`);
		}
		const runDir = this.runDirFor(graphId);
		const { baseGraph, authorization } = await this.loadRun(runDir, graphId);
		const effective = await this.withTopologySupervisor(graphId, runDir, authorization, async (capability) => {
			// Reload topology under the same fence as retry admission so an append
			// or cancellation cannot slip between host.loadRun and the baselines.
			const mutation = await readV3MutationJournal(runDir, baseGraph);
			await commitV3RetryIntent({
				runDir,
				graph: mutation.graph,
				runInstanceId: authorization.runInstanceId,
				taskId,
				cancelledTaskIds: mutation.cancelledTaskIds,
				capability,
			});
			return mutation.graph;
		});
		await initializeV3RunControl(runDir, authorization.runInstanceId, effective.graphId);
		await updateV3RunControl(runDir, "running", {
			runInstanceId: authorization.runInstanceId,
			graphId: effective.graphId,
		});
		await this.superviseResumedRun(graphId, runDir, effective, authorization);
		// Retry acknowledges once its intent is durable and a Supervisor has been
		// installed. Callers that need the terminal result use waitForCompletion().
		return this.status(graphId);
	}

	/** Permanently seal an OPEN graph; its Runner then derives a true terminal result. */
	async seal(graphId: string, expectedRevision: number): Promise<V3GraphMutationState> {
  await this.requireMailboxProtocol(graphId);
		const runDir = this.runDirFor(graphId);
		const { baseGraph, authorization } = await this.loadRun(runDir, graphId);
		const state = await this.withTopologySupervisor(graphId, runDir, authorization, (capability) =>
			sealV3Graph({ runDir, baseGraph, expectedRevision, capability }));
		// A fully quiesced OPEN stop is an execution pause, not final topology
		// evidence. Seal may advance that settled state so the Runner can compute
		// the SEALED terminal projection. wakeAfterTopologyMutation deliberately
		// refuses this transition while a stop still has a live Supervisor.
		await this.wakeAfterTopologyMutation(graphId, true);
		return state;
	}

	/** Rebuild immutable admission authority, then replay the mutation journal into the effective graph. */
	async loadRun(runDir: string, graphId?: string): Promise<LoadedV3Run> {
		const resolved = resolve(runDir);
		const [runsStat, runStat, canonicalRuns, canonicalRun] = await Promise.all([
			lstat(this.runsDir),
			lstat(resolved),
			realpath(this.runsDir),
			realpath(resolved),
		]);
		if (!runsStat.isDirectory() || runsStat.isSymbolicLink() || canonicalRuns !== this.runsDir) {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 runsDir must be a canonical non-symbolic-link directory.");
		}
		if (!runStat.isDirectory() || runStat.isSymbolicLink() || canonicalRun !== resolved || dirname(canonicalRun) !== canonicalRuns) {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 run root must be a direct, canonical, non-symbolic-link child of runsDir.");
		}
		if (graphId !== undefined && basename(canonicalRun) !== graphId) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 run root name '${basename(canonicalRun)}' does not match requested graph '${graphId}'.`);
		}
		const [authorizationRead, snapshotRead] = await Promise.all([
			readStableJson(join(resolved, "authorization.json"), "authorization.json"),
			readStableSnapshot(join(resolved, "snapshot.json")),
		]);
		if (detectRunFormat(snapshotRead.value, authorizationRead.value).kind !== "v3") {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 run authority files do not describe a V3 run.");
		}
		const authorization = validateAuthorizationV4(authorizationRead.value);
		const snapshot = validateGraphSnapshotV3(snapshotRead.value);
		if (snapshot.runInstanceId !== authorization.runInstanceId
			|| snapshot.graphId !== authorization.graph.graphId
			|| snapshot.graphDigest !== authorization.graphDigest
			|| snapshot.sourceGraphSpecDigest !== authorization.sourceGraphSpecDigest) {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 snapshot identity does not match immutable authorization.");
		}
		let observedSource;
		try {
			observedSource = await resolveSourceIdentityV3(authorization.sourceCwd);
		} catch (error) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 admitted source identity is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		if (observedSource.sourceCwd !== authorization.sourceCwd
			|| canonicalJson(observedSource.sourceRepository) !== canonicalJson(authorization.sourceRepository)) {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 admitted source directory or repository identity has changed.");
		}
		const [currentRun, currentAuthorization] = await Promise.all([
			lstat(resolved),
			readStableJson(join(resolved, "authorization.json"), "authorization.json"),
		]);
		if (currentRun.isSymbolicLink() || !currentRun.isDirectory()
			|| currentRun.dev !== runStat.dev || currentRun.ino !== runStat.ino
			|| !sameStableObservation(authorizationRead, currentAuthorization)) {
			graphV3Error("RUN_NEEDS_ATTENTION", "V3 run root or authorization changed while authority was verified.");
		}
		const baseGraph = compileGraphSpecV3(authorization.sourceGraphSpec as GraphSpecV3, { historical: true });
		if (baseGraph.sourceGraphSpecDigest !== authorization.sourceGraphSpecDigest) {
			graphV3Error("INVALID_AUTHORIZATION", "V3 run sourceGraphSpecDigest no longer matches its admitted source GraphSpec.", { field: "sourceGraphSpecDigest" });
		}
		if (baseGraph.graphDigest !== authorization.graphDigest) {
			graphV3Error("INVALID_AUTHORIZATION", "V3 run graphDigest no longer matches its admitted compiled graph.", { field: "graphDigest" });
		}
		if (graphId !== undefined && baseGraph.graphId !== graphId) {
			graphV3Error("INVALID_AUTHORIZATION", `V3 run directory identity '${graphId}' does not match admitted graph '${baseGraph.graphId}'.`);
		}
		const mutation = await readV3MutationJournal(resolved, baseGraph);
		return { baseGraph, graph: mutation.graph, mutation, authorization, runDir: resolved };
	}

	async isV3Run(runDir: string): Promise<boolean> {
		try {
			const resolved = resolve(runDir);
			const [rootStat, canonical, snapshot, authorization] = await Promise.all([
				lstat(resolved),
				realpath(resolved),
				readStableSnapshot(join(resolved, "snapshot.json")),
				readStableJson(join(resolved, "authorization.json"), "authorization.json"),
			]);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || canonical !== resolved || dirname(canonical) !== await realpath(this.runsDir)) return false;
			return detectRunFormat(snapshot.value, authorization.value).kind === "v3";
		} catch {
			return false;
		}
	}

	/** Start a new V3 graph: admit, initialize, and run in the background. */
	async start(spec: GraphSpecV3, sourceCwd: string): Promise<V3GraphRunHandle> {
		const graph = compileGraphSpecV3({ ...spec, contextPolicy: spec.contextPolicy ?? "v1" });
		const graphId = graph.graphId;
		const runDir = this.runDirFor(graphId);
		if (this.supervised.has(graphId)) graphV3Error("RUN_ALREADY_EXISTS", `V3 graph '${graphId}' is already supervised by this session.`, { details: { runDir } });
		const init = await initializeV3Run({
			trustedRoot: this.runsDir,
			runDir,
			graph,
			sessionId: this.context.sessionId,
			supervisorEpoch: this.context.supervisorEpoch,
			sourceCwd,
			runInstanceId: graphId,
		});
		await initializeV3RunControl(runDir, init.authorization.runInstanceId, graphId);
		// Production admission freezes every Agent definition before any node can
		// dispatch. Tests that inject preflight use the workspace's deterministic
		// synthetic profile instead of depending on a developer's ambient agents.
		if (!this.context.preflightAgent) await freezeV3GraphAgents(runDir, init.authorization.sourceCwd, graph.nodes);
		const runner = new V3GraphRunner(this.runnerOptions(runDir, graph, init.authorization, init.authorization.sourceCwd));
		this.supervise(graphId, runner);
		const mutation = await readV3MutationJournal(runDir, graph);
		const snapshot = await buildV3SnapshotProjection({
			runDir,
			graph,
			authorization: init.authorization,
			sessionId: init.authorization.sessionId,
			supervisorEpoch: init.authorization.supervisorEpoch,
			...this.dynamicProjection(mutation),
		});
		return new V3GraphRunHandle(this, { graph, runDir, graphId, snapshot });
	}

	/** Explicit handle-named alias for callers migrating from V3StartResult. */
	startHandle(spec: GraphSpecV3, sourceCwd: string): Promise<V3GraphRunHandle> {
		return this.start(spec, sourceCwd);
	}

	/** Open a durable handle without adopting or starting execution. */
	async openHandle(graphId: string): Promise<V3GraphRunHandle> {
		const runDir = this.runDirFor(graphId);
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		await initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId);
		const snapshot = await this.status(graphId);
		return new V3GraphRunHandle(this, { graph, runDir, graphId, snapshot });
	}

	/** Read the durable desired state without conflating it with observed status. */
	async control(graphId: string): Promise<V3RunControl> {
		const runDir = this.runDirFor(graphId);
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		return initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId);
	}

	/** Persist a control command before applying any process-local side effect. */
	async requestDesiredState(
		graphId: string,
		desiredState: V3DesiredState,
		options: V3ControlMutationOptions = {},
	): Promise<V3RunControl> {
		if (desiredState === "running") this.supervisorHandoffFailures.delete(graphId);
		let handoff = desiredState === "running" && this.supervised.has(graphId)
			? this.reserveSupervisorHandoff(graphId)
			: undefined;
		try {
			const runDir = this.runDirFor(graphId);
			const { graph, authorization } = await this.loadRun(runDir, graphId);
   if(!await this.hasMailboxProtocol(runDir,authorization.runInstanceId))throw new Error("Legacy communication contract: read-only inspection only.");
			await initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId);
			const control = await updateV3RunControl(runDir, desiredState, {
				...options,
				runInstanceId: authorization.runInstanceId,
				graphId: graph.graphId,
			});
			if (desiredState === "stopped") this.supervised.get(graphId)?.runner.requestStop();
			if (desiredState === "paused") this.supervised.get(graphId)?.runner.requestPause();
			if (desiredState === "running") {
				const current = this.supervised.get(graphId);
				if (current?.runner.isPauseRequested) {
					// Resume can race the quiescent paused return. Reserve the provider
					// identity until a successor is installed so bg_wait cannot observe
					// a false completion between the two real Supervisors.
					handoff ??= this.reserveSupervisorHandoff(graphId);
					this.continueAfterPausedSupervisor(graphId, runDir, graph, authorization, current.promise, handoff);
					handoff = undefined;
				} else if (!current) {
					// initializeForResume may read substantial Attempt evidence, but run()
					// is registered and left in the background; callers receive the
					// committed control revision rather than terminal execution.
					await this.superviseResumedRun(graphId, runDir, graph, authorization);
				}
			}
			return control;
		} finally {
			if (handoff) this.releaseSupervisorHandoff(graphId, handoff);
		}
	}

	/** Persist pause intent, then wait for this Host's active Supervisor to quiesce. */
	async pause(graphId: string): Promise<GraphSnapshotV3> {
  await this.requireMailboxProtocol(graphId);
		await this.requestDesiredState(graphId, "paused");
		const supervised = this.supervised.get(graphId);
		if (supervised) return supervised.promise;
		return this.status(graphId);
	}

	/** Live status projection for a V3 run. */
	async status(graphId: string): Promise<GraphSnapshotV3> {
		const runDir = this.runDirFor(graphId);
		const { graph, mutation, authorization } = await this.loadRun(runDir, graphId);
		const supervised = this.supervised.get(graphId);
		const control = await this.hasMailboxProtocol(runDir,authorization.runInstanceId) ? await initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId) : await readV3RunControl(runDir).catch(()=>({runInstanceId:authorization.runInstanceId,graphId:graph.graphId,desiredState:"running" as const}));
		if (control.runInstanceId !== authorization.runInstanceId || control.graphId !== graph.graphId) {
			graphV3Error("RUN_NEEDS_ATTENTION", `V3 graph '${graphId}' control identity does not match its authorization.`);
		}
		const stopRequested = control.desiredState === "stopped" || supervised?.runner.isStopRequested === true;
		const paused = control.desiredState === "paused" || supervised?.runner.isPauseRequested === true;
		const retryBaselines = await latestV3RetryBaselines(runDir, authorization.runInstanceId, graph.graphId);
		return buildV3SnapshotProjection({
			runDir,
			graph,
			authorization,
			sessionId: authorization.sessionId,
			supervisorEpoch: authorization.supervisorEpoch,
			...(retryBaselines ? { retryBaselines } : {}),
			...(stopRequested ? { stopRequested: true } : {}),
			...(paused && !stopRequested ? { projectionStatusOverride: "paused" } : {}),
			...this.dynamicProjection(mutation),
		});
	}

	/**
	 * Await the observed result for the latest durable intent. A Supervisor may
	 * quiesce on a paused revision just before a newer running/stopped revision is
	 * committed; in that case its paused snapshot is stale and a fresh Supervisor
	 * must continue without writing another control revision.
	 */
	async waitForCompletion(graphId: string): Promise<GraphSnapshotV3> {
		while (true) {
			const pending = this.supervisorHandoffContinuations.get(graphId);
			if (pending?.size) {
				await Promise.all([...pending]);
				continue;
			}
			if (this.supervisorHandoffFailures.has(graphId) && (await this.control(graphId)).desiredState === "running") {
				throw this.supervisorHandoffFailures.get(graphId);
			}
			const supervised = this.supervised.get(graphId);
			const snapshot = supervised ? await supervised.promise : await this.status(graphId);
			if (supervised && this.supervised.get(graphId)?.promise === supervised.promise) {
				// The promise is settled and its lease has been released. Do not let a
				// lagging finally callback hide the successor started below.
				this.supervised.delete(graphId);
				this.notifyActiveWorkChange();
			}
			if (this.supervisorHandoffContinuations.get(graphId)?.size) continue;
			if (snapshot.status !== "paused") return snapshot;
			const control = await this.control(graphId);
			if (control.desiredState === "paused") return snapshot;
			const runDir = this.runDirFor(graphId);
			const { graph, authorization } = await this.loadRun(runDir, graphId);
			await this.superviseResumedRun(graphId, runDir, graph, authorization);
		}
	}

	/**
	 * Stop a V3 run. If this session supervises it, request a graceful stop and wait.
	 * Otherwise adopt it (load on-disk state), request a stop, and run to a stopped
	 * snapshot; a live lease held by another process surfaces as needs_attention.
	 */
	async stop(graphId: string): Promise<GraphSnapshotV3> {
  await this.requireMailboxProtocol(graphId);
		const runDir = this.runDirFor(graphId);
		await this.requestDesiredState(graphId, "stopped");
		const supervised = this.supervised.get(graphId);
		if (supervised) {
			return supervised.promise;
		}
		const { graph, authorization } = await this.loadRun(runDir, graphId);
		const runner = new V3GraphRunner(this.runnerOptions(runDir, graph, authorization, authorization.sourceCwd));
		await runner.initializeForResume();
		runner.requestStop();
		const promise = this.supervise(graphId, runner);
		return promise;
	}

	/** Resume a crashed/interrupted V3 run (crash recovery). */
	async resume(graphId: string): Promise<GraphSnapshotV3> {
  await this.requireMailboxProtocol(graphId);
		await this.requestDesiredState(graphId, "running");
		while (true) {
			let supervised = this.supervised.get(graphId);
			if (!supervised) {
				const runDir = this.runDirFor(graphId);
				const { graph, authorization } = await this.loadRun(runDir, graphId);
				const control = await initializeV3RunControl(runDir, authorization.runInstanceId, graph.graphId);
				if (control.desiredState !== "running") return this.status(graphId);
				await this.superviseResumedRun(graphId, runDir, graph, authorization);
				supervised = this.supervised.get(graphId);
			}
			if (!supervised) return this.status(graphId);
			const snapshot = await supervised.promise;
			if (snapshot.status !== "paused") return snapshot;
			const control = await this.control(graphId);
			if (control.desiredState !== "running") return this.status(graphId);
		}
	}

	/** List V3 runs with their live projections. Legacy runs are not shown here. */
	async list(): Promise<V3GraphSummary[]> {
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		const summaries: V3GraphSummary[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			try {
				const supervised = this.supervised.has(entry.name);
				const snapshot = await this.status(entry.name);
				summaries.push({ graphId: entry.name, runDir, snapshot, supervised });
			} catch (error) {
				// Unreadable or tampered V3 runs are reported by doctor, not list.
			}
		}
		summaries.sort((left, right) => right.snapshot.createdAt.localeCompare(left.snapshot.createdAt));
		return summaries;
	}

	/** Synchronous background-work inventory for the Pi host session. */
	listActiveWork(): Array<{ id: string; sessionId: string }> {
		const owners = new Map<string, string>();
		for (const [id, entry] of this.supervised) owners.set(id, entry.ownerSessionId);
		for (const [id, reservations] of this.supervisorHandoffs) {
			const ownerSessionId = [...reservations.values()].at(-1);
			if (ownerSessionId) owners.set(id, ownerSessionId);
		}
		return [...owners].map(([id, sessionId]) => ({ id, sessionId }));
	}

	/** Adoption scan. Automatic startup must supply the current Pi session ID;
	 * unscoped scans remain available to explicit recovery callers. */
	async adoptCrashedRuns(options: { sessionId?: string } = {}): Promise<Array<{ graphId: string; outcome: "resumed" | "needs_attention" | "skipped" }>> {
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		const adopted: Array<{ graphId: string; outcome: "resumed" | "needs_attention" | "skipped" }> = [];
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			if (this.supervised.has(entry.name)) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			let snapshot: GraphSnapshotV3;
			try {
				if(!await this.hasMailboxProtocol(runDir)){adopted.push({graphId:entry.name,outcome:"skipped"});continue;}
				// Filter by immutable admission identity before status/control reads,
				// which may initialize durable state, or installing a Supervisor.
				// Sharing a working directory never implies sharing a Pi session.
				if (options.sessionId !== undefined) {
					const authorization = validateAuthorizationV4((await readStableJson(join(runDir, "authorization.json"), "authorization.json")).value);
					if (authorization.sessionId !== options.sessionId) continue;
				}
				// Recompute from safe on-site authority and Attempt evidence. The mutable
				// persisted snapshot is a cache, not adoption authority.
				snapshot = await this.status(entry.name);
			} catch {
				adopted.push({ graphId: entry.name, outcome: "needs_attention" });
				continue;
			}
			try {
				const control = await this.control(entry.name);
				const loaded = await this.loadRun(runDir, entry.name);
				const retryPending = await pendingV3RetryBaselines(
					runDir,
					loaded.authorization.runInstanceId,
					loaded.graph.graphId,
					loaded.graph,
					loaded.mutation.cancelledTaskIds,
				) !== undefined;
				if (retryPending) {
					await this.requestDesiredState(entry.name, "running");
					adopted.push({ graphId: entry.name, outcome: "resumed" });
					continue;
				}
				if (control.desiredState === "paused") {
					adopted.push({ graphId: entry.name, outcome: "skipped" });
					continue;
				}
				if (control.desiredState === "stopped") {
					// A stopped intent is projected as `stopped` as soon as no Attempt is
					// actively running. Queued nodes still require a real Supervisor pass
					// to publish their no-dispatch aborted evidence; graph status alone
					// therefore cannot prove that offline stop finalization has completed.
					const stopFinalized = loaded.graph.nodes.every((node) =>
						snapshot.nodes?.[node.taskId]?.terminalStatus !== undefined);
					if (stopFinalized) continue;
					await this.stop(entry.name);
				} else {
					// A paused projection is terminal only while the durable intent is
					// paused. A committed running intent makes it resumable again.
					if (TERMINAL_STATUSES.has(snapshot.status) && snapshot.status !== "paused") continue;
					await this.requestDesiredState(entry.name, "running");
				}
				adopted.push({ graphId: entry.name, outcome: "resumed" });
			} catch (error) {
				adopted.push({ graphId: entry.name, outcome: "needs_attention" });
			}
		}
		return adopted;
	}

	/** Doctor: report lease health, orphan shadow dirs, invalid runs, and needs_attention runs. */
	async doctor(): Promise<V3DoctorReport> {
		const issues: V3DoctorIssue[] = [];
		const entries = await readdir(this.runsDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
			const runDir = join(this.runsDir, entry.name);
			if (!await this.isV3Run(runDir)) continue;
			const paths = v3RunPaths(runDir);
			const lease = await readV3RunLease(paths.leasePath);
			if (lease && !await this.leaseIsLive(lease)) {
				issues.push({ kind: "stale-lease", runId: entry.name, detail: `Lease records ${lease.pid} but that process identity is no longer alive; a resume will take it over.` });
			}
			issues.push(...await this.orphanShadows(entry.name, runDir));
			try {
				const snapshot = await this.status(entry.name);
				if (snapshot.status === "needs_attention") issues.push({ kind: "needs-attention", runId: entry.name, detail: "Run is in needs_attention and will not auto-resume." });
			} catch (error) {
				issues.push({ kind: "invalid-run", runId: entry.name, detail: error instanceof Error ? error.message : String(error) });
			}
		}
		return { issues, supervised: [...this.supervised.keys()] };
	}

	private async leaseIsLive(lease: NonNullable<Awaited<ReturnType<typeof readV3RunLease>>>): Promise<boolean> {
		try {
			validateV3RunLease(lease);
			return (await import("./claims.ts")).processIdentityForPid(lease.pid) !== undefined;
		} catch {
			return false;
		}
	}

	private async orphanShadows(graphId: string, runDir: string): Promise<V3DoctorIssue[]> {
		const { readdir: readShadowDirs, stat } = await import("node:fs/promises");
		const shadowRoot = join(runDir, "shadow");
		const children = await readShadowDirs(shadowRoot).catch(() => []);
		const issues: V3DoctorIssue[] = [];
		for (const child of children) {
			const shadowDir = join(shadowRoot, child);
			const info = await stat(shadowDir).catch(() => undefined);
			if (!info || !info.isDirectory()) continue;
			const taskId = child;
			const latest = await readLatestV3Attempt(runDir, taskId);
			const evidenceDir = v3NodeAttemptDir(runDir, taskId, latest?.attempt ?? 1);
			const referenced = latest && (latest.evidence.phase === "running" || latest.evidence.phase === "verifying" || latest.evidence.phase === "applying" || latest.evidence.phase === "prepared" || latest.evidence.phase === "dispatched");
			if (!referenced) {
				const evidenceExists = await stat(join(evidenceDir, "workspace.json")).then(() => true).catch(() => false);
				if (!evidenceExists || latest?.evidence.phase === "accepted" || latest?.evidence.phase === "failed" || latest?.evidence.phase === "aborted") {
					issues.push({ kind: "orphan-shadow", runId: graphId, detail: `Shadow directory '${shadowDir}' is not referenced by any active attempt.` });
				}
			}
		}
		return issues;
	}
}

export async function graphStatusTextV3(snapshot: GraphSnapshotV3, runsDir: string): Promise<string> {
	const nodeLines: string[] = [];
	for (const [taskId, node] of Object.entries(snapshot.nodes ?? {})) {
		const phase = node.terminalStatus ?? node.phase;
		const observation = node.observation;
		const usage = observation?.usage;
		const tokens = reportedTotalTokens(usage);
		const turns = observation?.progress?.turnCount ?? usage?.turns;
		const facts = [
			...supervisionFacts(observation),
			node.attempt > 0 ? `attempt ${node.attempt}` : undefined,
			observation?.requestedAgent ? `requested agent ${observation.requestedAgent}` : undefined,
			(observation?.resolvedAgent ?? node.agent) ? `resolved agent ${observation?.resolvedAgent ?? node.agent}` : undefined,
			observation?.actualAgent ? `actual agent ${observation.actualAgent}` : undefined,
			observation?.requestedModel ? `requested model ${observation.requestedModel}` : undefined,
			observation?.resolvedModel ? `resolved model ${observation.resolvedModel}` : undefined,
			observation?.actualModel ? `actual model ${observation.actualModel}` : undefined,
			tokens !== undefined ? `${tokens} tokens` : undefined,
			usage?.costUsd !== undefined ? `cost $${usage.costUsd.toFixed(usage.costUsd < 0.01 ? 4 : 2)}` : undefined,
			turns !== undefined ? `${turns} turns` : undefined,
			observation?.progress?.toolCount !== undefined ? `${observation.progress.toolCount} tools` : undefined,
			observation?.runId ? `child run ${observation.runId}` : undefined,
			observation?.asyncId ? `async ${observation.asyncId}` : undefined,
			observation?.sessionFile ? `session ${basename(observation.sessionFile)}` : undefined,
			observation?.progress?.currentTool ? `tool ${observation.progress.currentTool}` : undefined,
			observation?.progress?.currentPath ? `path ${observation.progress.currentPath}` : undefined,
			observation?.durationMs !== undefined ? `duration ${observation.durationMs}ms` : undefined,
		].filter((fact): fact is string => fact !== undefined);
		const dependencies = node.dependsOn?.length ? ` ← ${node.dependsOn.join(", ")}` : "";
		nodeLines.push(`  - ${taskId}${dependencies}: ${phase}${facts.length ? ` (${facts.join(" · ")})` : ""}`);
	}
	return [
		`Graph: ${snapshot.graphId}`,
		`Status: ${snapshot.status}`,
		...(snapshot.revision === undefined ? [] : [`Revision: ${snapshot.revision} · ${snapshot.sealed ? "sealed" : "open"}`]),
		`Created: ${snapshot.createdAt}`,
		`State: ${join(resolve(runsDir), snapshot.graphId, "snapshot.json")}`,
		`Nodes:${nodeLines.length ? `\n${nodeLines.join("\n")}` : " (none)"}`,
	].join("\n");
}

export function v3IsGraphSpecV3(spec: unknown): spec is GraphSpecV3 {
	return typeof spec === "object" && spec !== null && (spec as { schemaVersion?: unknown }).schemaVersion === 3;
}

export function isV3GraphError(error: unknown): boolean {
	return error instanceof GraphV3Error;
}
