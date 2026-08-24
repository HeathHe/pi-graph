import type { CompiledGraphV3, CompiledGraphNodeV3, V3NodePhase, V3NodeSyntheticPhase, V3NodeTerminal } from "./types.ts";
import { isV3TerminalPhase } from "./attempt.ts";

export interface V3NodePhaseView {
	phaseOf(taskId: string): V3NodeSchedulingStatus | undefined;
}

export type V3NodeSchedulingStatus = V3NodePhase | V3NodeSyntheticPhase;
export type V3NodeReadiness =
	| { state: "ready" }
	| { state: "waiting" | "skipped" | "blocked"; detail: string };

const BLOCKING_DEPENDENCY_PHASES = new Set<V3NodeSchedulingStatus>(["failed", "aborted", "needs_attention", "blocked", "cancelled"]);

/**
 * Pure readiness classification for static or dynamically appended nodes.
 * A matching `when: failed` edge is the only dependency that may be satisfied
 * by failure; the original failure remains terminal evidence for the graph.
 */
export function v3EvaluateNodeReadiness(
	node: CompiledGraphNodeV3,
	statusOf: (taskId: string) => V3NodeSchedulingStatus | undefined,
): V3NodeReadiness {
	const condition = node.when;
	if (condition !== undefined) {
		const actual = statusOf(condition.node);
		if (actual === "accepted" || actual === "failed") {
			if (actual !== condition.status) return { state: "skipped", detail: `condition not met: ${condition.node} is ${actual}, expected ${condition.status}` };
		} else if (actual === "skipped") {
			return { state: "skipped", detail: `skipped by: ${condition.node}` };
		} else if (actual !== undefined && BLOCKING_DEPENDENCY_PHASES.has(actual)) {
			return { state: "blocked", detail: `blocked by: ${condition.node}` };
		} else {
			return { state: "waiting", detail: `waiting for: ${condition.node}` };
		}
	}

	const skipped: string[] = [];
	const blocked: string[] = [];
	const waiting: string[] = [];
	for (const dependency of node.dependsOn) {
		// A matched condition edge is satisfied even when the source failed. The
		// condition was fully classified above; every other direct dependency
		// must still settle before this node becomes ready.
		if (condition?.node === dependency) continue;
		const status = statusOf(dependency);
		if (status === "accepted") continue;
		if (status === "skipped") skipped.push(dependency);
		else if (status !== undefined && BLOCKING_DEPENDENCY_PHASES.has(status)) blocked.push(dependency);
		else waiting.push(dependency);
	}
	if (blocked.length > 0) return { state: "blocked", detail: `blocked by: ${blocked.join(", ")}` };
	if (skipped.length > 0) return { state: "skipped", detail: `skipped by: ${skipped.join(", ")}` };
	if (waiting.length > 0) return { state: "waiting", detail: `waiting for: ${waiting.join(", ")}` };
	return { state: "ready" };
}

export function v3NodeIsTerminal(phase: V3NodeSchedulingStatus | undefined): phase is V3NodeSchedulingStatus {
	return phase !== undefined && (phase === "skipped" || phase === "blocked" || phase === "cancelled" || isV3TerminalPhase(phase));
}

export function v3NodeTerminalOf(phase: V3NodePhase): V3NodeTerminal {
	if (phase === "accepted") return "accepted";
	if (phase === "failed") return "failed";
	if (phase === "aborted") return "aborted";
	if (phase === "needs_attention") return "needs_attention";
	throw new Error(`V3 phase '${phase}' is not terminal.`);
}

/**
 * Nodes whose dependencies are all accepted and which have not started yet.
 * Terminal nodes and already-started nodes are never returned.
 */
export function v3ReadyNodes(graph: CompiledGraphV3, view: V3NodePhaseView): CompiledGraphNodeV3[] {
	const ready: CompiledGraphNodeV3[] = [];
	for (const node of graph.nodes) {
		const phase = view.phaseOf(node.taskId);
		if (phase !== undefined) continue;
		if (v3EvaluateNodeReadiness(node, (taskId) => view.phaseOf(taskId)).state !== "ready") continue;
		ready.push(node);
	}
	return ready;
}

/** True when every non-terminal node has started and no node is waiting on a dependency. */
export function v3GraphBlocked(graph: CompiledGraphV3, view: V3NodePhaseView): boolean {
	const pending = graph.nodes.filter((node) => !v3NodeIsTerminal(view.phaseOf(node.taskId)));
	if (pending.length === 0) return false;
	return pending.every((node) => {
		const phase = view.phaseOf(node.taskId);
		if (phase !== undefined) return true; // started but not terminal
		return v3EvaluateNodeReadiness(node, (taskId) => view.phaseOf(taskId)).state !== "ready";
	});
}

export function v3PendingNodes(graph: CompiledGraphV3, view: V3NodePhaseView): CompiledGraphNodeV3[] {
	return graph.nodes.filter((node) => !v3NodeIsTerminal(view.phaseOf(node.taskId)));
}

/**
 * Rebuild projection-only terminal states to a fixed point. Cancellation is
 * journal authority; conditional skips and dependency blocks are pure
 * consequences of that authority plus terminal Attempt evidence.
 */
export function v3SyntheticNodeStatuses(
	graph: CompiledGraphV3,
	view: V3NodePhaseView,
	cancelledTaskIds: ReadonlySet<string>,
): Map<string, V3NodeSyntheticPhase> {
	const synthetic = new Map<string, V3NodeSyntheticPhase>();
	for (const taskId of cancelledTaskIds) synthetic.set(taskId, "cancelled");
	const statusOf = (taskId: string): V3NodeSchedulingStatus | undefined => synthetic.get(taskId) ?? view.phaseOf(taskId);
	let changed = true;
	while (changed) {
		changed = false;
		for (const node of graph.nodes) {
			if (synthetic.has(node.taskId) || view.phaseOf(node.taskId) !== undefined) continue;
			const readiness = v3EvaluateNodeReadiness(node, statusOf);
			if (readiness.state !== "skipped" && readiness.state !== "blocked") continue;
			synthetic.set(node.taskId, readiness.state);
			changed = true;
		}
	}
	return synthetic;
}
