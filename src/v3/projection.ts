import { readLatestV3Attempt, verifyV3AcceptedAttemptChain } from "./attempt.ts";
import { v3SyntheticNodeStatuses } from "./scheduler.ts";
import { validateGraphSnapshotV3 } from "./snapshot.ts";
import type {
	AuthorizationV4,
	CompiledGraphV3,
	GraphRuntimeStatusV3,
	GraphSnapshotV3,
	V3NodeProjection,
} from "./types.ts";

export interface V3ProjectionInput {
	runDir: string;
	graph: CompiledGraphV3;
	authorization: AuthorizationV4;
	sessionId: string;
	supervisorEpoch: string;
	stopRequested?: boolean;
	projectionStatusOverride?: GraphRuntimeStatusV3;
	/** Effective topology rebuilt from the immutable base graph plus its journal. */
	topology?: "open" | "sealed";
	revision?: number;
	sealed?: boolean;
	cancelledTaskIds?: readonly string[];
	topologyUpdatedAt?: string;
	/** Latest durable retry baseline. A node still at this Attempt is logically reset. */
	retryBaselines?: Readonly<Record<string, number>>;
}

export interface V3NodeRuntimeState {
	phase: string;
	attempt: number;
	terminalStatus?: string;
	updatedAt: string;
}

export async function buildV3SnapshotProjection(input: V3ProjectionInput): Promise<GraphSnapshotV3> {
	const nodeStates = new Map<string, V3NodeRuntimeState>();
	for (const node of input.graph.nodes) {
		const latest = await readLatestV3Attempt(input.runDir, node.taskId);
		const retryBaseline = input.retryBaselines?.[node.taskId];
		if (!latest) {
			nodeStates.set(node.taskId, retryBaseline !== undefined && retryBaseline !== 0
				? { phase: "needs_attention", attempt: 0, terminalStatus: "needs_attention", updatedAt: input.authorization.createdAt }
				: { phase: "queued", attempt: 0, updatedAt: input.authorization.createdAt });
			continue;
		}
		if (retryBaseline !== undefined && latest.attempt < retryBaseline) {
			nodeStates.set(node.taskId, {
				phase: "needs_attention",
				attempt: latest.attempt,
				terminalStatus: "needs_attention",
				updatedAt: latest.evidence.updatedAt,
			});
			continue;
		}
		if (retryBaseline !== undefined && latest.attempt === retryBaseline) {
			nodeStates.set(node.taskId, {
				phase: "queued",
				attempt: latest.attempt,
				updatedAt: latest.evidence.updatedAt,
			});
			continue;
		}
		if (latest.evidence.phase === "accepted") {
			const chain = await verifyV3AcceptedAttemptChain(input.runDir, node.taskId, latest.attempt, {
				runInstanceId: input.authorization.runInstanceId,
				graphId: input.graph.graphId,
				method: node.sideEffect === "local_write" ? "machine-verified" : "declared",
			});
			if (!chain.ok) {
				nodeStates.set(node.taskId, {
					phase: "needs_attention",
					attempt: latest.attempt,
					terminalStatus: "needs_attention",
					updatedAt: latest.evidence.updatedAt,
				});
				continue;
			}
		}
		nodeStates.set(node.taskId, {
			phase: latest.evidence.phase,
			attempt: latest.evidence.attempt,
			...(latest.evidence.terminalStatus ? { terminalStatus: latest.evidence.terminalStatus } : {}),
			updatedAt: latest.evidence.updatedAt,
		});
	}
	const attemptView = { phaseOf: (taskId: string) => {
		const state = nodeStates.get(taskId);
		return state?.phase === "queued" ? undefined : state?.phase as import("./types.ts").V3NodePhase | undefined;
	} };
	const synthetic = v3SyntheticNodeStatuses(input.graph, attemptView, new Set(input.cancelledTaskIds ?? []));
	for (const [taskId, phase] of synthetic) {
		const prior = nodeStates.get(taskId);
		nodeStates.set(taskId, {
			phase,
			attempt: prior?.attempt ?? 0,
			terminalStatus: phase,
			updatedAt: input.topologyUpdatedAt ?? prior?.updatedAt ?? input.authorization.createdAt,
		});
	}
	const sealed = input.sealed ?? true;
	const status = input.projectionStatusOverride ?? deriveGraphStatus(nodeStates, input.stopRequested, sealed);
	const nodes: Record<string, V3NodeProjection> = {};
	for (const node of input.graph.nodes) {
		const state = nodeStates.get(node.taskId)!;
		nodes[node.taskId] = { phase: state.phase as V3NodeProjection["phase"], attempt: state.attempt, ...(state.terminalStatus ? { terminalStatus: state.terminalStatus as V3NodeProjection["terminalStatus"] } : {}) };
	}
	let updatedAt = input.topologyUpdatedAt ?? input.authorization.createdAt;
	for (const state of nodeStates.values()) {
		if (Date.parse(state.updatedAt) > Date.parse(updatedAt)) updatedAt = state.updatedAt;
	}
	return validateGraphSnapshotV3({
		schemaVersion: 3,
		runInstanceId: input.authorization.runInstanceId,
		graphId: input.graph.graphId,
		// These are immutable authorization identities. Dynamic topology is bound
		// by its digest-chained revision journal and is projected separately.
		graphDigest: input.authorization.graphDigest,
		sourceGraphSpecDigest: input.authorization.sourceGraphSpecDigest,
		status,
		sessionId: input.sessionId,
		supervisorEpoch: input.supervisorEpoch,
		createdAt: input.authorization.createdAt,
		updatedAt,
		...(input.topology === undefined || input.revision === undefined || input.sealed === undefined
			? {}
			: { topology: input.topology, revision: input.revision, sealed: input.sealed }),
		nodes,
	});
}

function deriveGraphStatus(nodeStates: Map<string, V3NodeRuntimeState>, stopRequested: boolean | undefined, sealed: boolean): GraphRuntimeStatusV3 {
	let anyRunning = false;
	let anyFailed = false;
	let anyAttention = false;
	let allTerminal = true;
	for (const state of nodeStates.values()) {
		if (state.phase === "needs_attention") anyAttention = true;
		else if (state.phase === "failed") anyFailed = true;
		else if (["running", "verifying", "applying", "dispatched", "prepared"].includes(state.phase)) anyRunning = true;
		if (!["accepted", "failed", "aborted", "needs_attention", "skipped", "blocked", "cancelled"].includes(state.phase)) allTerminal = false;
	}
	if (anyAttention) return "needs_attention";
	if (stopRequested) return anyRunning ? "stopping" : "stopped";
	if (!sealed && allTerminal) return "idle";
	if (allTerminal) {
		if (anyFailed) return "failed";
		if ([...nodeStates.values()].some((state) => state.phase === "aborted")) return "stopped";
		return "complete";
	}
	if (anyRunning) return "running";
	return "queued";
}
