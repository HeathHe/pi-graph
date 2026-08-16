import type { CompiledGraphV3, CompiledGraphNodeV3, V3NodePhase, V3NodeTerminal } from "./types.ts";
import { isV3TerminalPhase } from "./attempt.ts";

export interface V3NodePhaseView {
	phaseOf(taskId: string): V3NodePhase | undefined;
}

export function v3NodeIsTerminal(phase: V3NodePhase | undefined): phase is V3NodePhase {
	return phase !== undefined && isV3TerminalPhase(phase);
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
		if (!node.dependsOn.every((dependency) => view.phaseOf(dependency) === "accepted")) continue;
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
		return !node.dependsOn.every((dependency) => view.phaseOf(dependency) === "accepted");
	});
}

export function v3PendingNodes(graph: CompiledGraphV3, view: V3NodePhaseView): CompiledGraphNodeV3[] {
	return graph.nodes.filter((node) => !v3NodeIsTerminal(view.phaseOf(node.taskId)));
}
