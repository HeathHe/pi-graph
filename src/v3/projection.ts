import { readLatestV3Attempt } from "./attempt.ts";
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
		nodeStates.set(node.taskId, latest
			? { phase: latest.evidence.phase, attempt: latest.evidence.attempt, ...(latest.evidence.terminalStatus ? { terminalStatus: latest.evidence.terminalStatus } : {}), updatedAt: latest.evidence.updatedAt }
			: { phase: "queued", attempt: 0, updatedAt: input.authorization.createdAt });
	}
	const status = input.projectionStatusOverride ?? deriveGraphStatus(nodeStates, input.stopRequested);
	const nodes: Record<string, V3NodeProjection> = {};
	for (const node of input.graph.nodes) {
		const state = nodeStates.get(node.taskId)!;
		nodes[node.taskId] = { phase: state.phase as V3NodeProjection["phase"], attempt: state.attempt, ...(state.terminalStatus ? { terminalStatus: state.terminalStatus as V3NodeProjection["terminalStatus"] } : {}) };
	}
	let updatedAt = input.authorization.createdAt;
	for (const state of nodeStates.values()) {
		if (Date.parse(state.updatedAt) > Date.parse(updatedAt)) updatedAt = state.updatedAt;
	}
	return validateGraphSnapshotV3({
		schemaVersion: 3,
		runInstanceId: input.authorization.runInstanceId,
		graphId: input.graph.graphId,
		graphDigest: input.graph.graphDigest,
		sourceGraphSpecDigest: input.graph.sourceGraphSpecDigest,
		status,
		sessionId: input.sessionId,
		supervisorEpoch: input.supervisorEpoch,
		createdAt: input.authorization.createdAt,
		updatedAt,
		nodes,
	});
}

function deriveGraphStatus(nodeStates: Map<string, V3NodeRuntimeState>, stopRequested?: boolean): GraphRuntimeStatusV3 {
	if (stopRequested) return "stopped";
	let anyRunning = false;
	let anyFailed = false;
	let anyAttention = false;
	let allTerminal = true;
	for (const state of nodeStates.values()) {
		if (state.phase === "needs_attention") anyAttention = true;
		else if (state.phase === "failed") anyFailed = true;
		else if (["running", "verifying", "applying", "dispatched", "prepared"].includes(state.phase)) anyRunning = true;
		if (!["accepted", "failed", "aborted", "needs_attention"].includes(state.phase)) allTerminal = false;
	}
	if (anyAttention) return "needs_attention";
	if (allTerminal) {
		const accepted = [...nodeStates.values()].every((state) => state.phase === "accepted");
		if (accepted) return "complete";
		if (anyFailed) return "failed";
		return "stopped";
	}
	if (anyRunning) return "running";
	return "queued";
}
