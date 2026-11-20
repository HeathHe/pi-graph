/**
 * Coordinator Tracker — Unified progress tracking for maestro coordinators
 *
 * Tracks session state across three coordinator types:
 *   A) canonical — reads .workflow/sessions/{id}/session.json for every engine
 *      maestro (legacy) — reads .workflow/.maestro/status.json
 *   B) maestro-link-coordinate — captures coord session_id from Bash output,
 *      reads .workflow/.maestro/walker-state.json
 *
 * Bridge file: {tmpdir}/maestro-coord-{cc_session_id}.json
 */
export type CoordinatorType = 'maestro' | 'ralph' | 'maestro-link-coordinate';
export interface CoordStep {
    index: number;
    skill: string;
    args: string;
}
export interface CoordBridgeData {
    session_id: string;
    coord_session_id?: string;
    maestro_session_id?: string;
    coordinator: CoordinatorType;
    source?: 'maestro' | 'ralph';
    chain_name: string;
    intent: string;
    phase: number | null;
    steps_total: number;
    steps_completed: number;
    /** Real step counts excluding decision nodes (ralph sessions inflate totals with decision nodes) */
    steps_real?: number;
    steps_real_completed?: number;
    current_step: CoordStep | null;
    next_step: CoordStep | null;
    remaining_steps: Array<{
        skill: string;
        args: string;
    }>;
    status: string;
    auto_mode?: boolean;
    /** Ralph-specific: current lifecycle position (e.g., "verify", "post-review") */
    lifecycle_position?: string;
    /** Ralph-specific: quality pipeline mode ("full" | "standard" | "quick") */
    quality_mode?: string;
    /** Ralph-specific: true when current step is a decision node awaiting evaluation */
    decision_pending?: boolean;
    /** Ralph-specific: quality gates already passed */
    passed_gates?: string[];
    updated_at: number;
}
/** Parsed output from `maestro coordinate start/next` JSON */
export interface CoordinateCliOutput {
    session_id: string;
    status: string;
    graph_id: string;
    current_node: string;
    steps_completed: number;
    steps_failed: number;
    history: Array<{
        node_id: string;
        outcome?: string;
        summary?: string;
    }>;
}
/**
 * Read the most recent canonical/legacy maestro session.
 * Checks standard `.workflow/sessions/` first (all engines),
 * then falls back to legacy `.workflow/.maestro/` (maestro static chain).
 */
export declare function readMaestroSession(workspaceRoot: string): CoordBridgeData | null;
/**
 * Parse Bash tool output for coordinate session JSON.
 * Looks for JSON containing "session_id":"coord-..." pattern.
 * Returns parsed output or null if not coordinate output.
 */
export declare function parseCoordinateOutput(toolOutput: string): CoordinateCliOutput | null;
/**
 * Read walker-state.json for a specific coordinate session.
 * Resolves next node from the chain graph.
 */
export declare function readWalkerState(workspaceRoot: string, coordSessionId: string): CoordBridgeData | null;
/**
 * Resolve the next command node from a chain graph JSON file.
 * Follows `node.next` edges, skipping decision/gate/eval nodes.
 */
export declare function resolveNextNode(workspaceRoot: string, graphId: string, currentNode: string): {
    skill: string;
    args: string;
} | null;
/** Write bridge file to tmpdir. */
export declare function writeCoordBridge(sessionId: string, data: CoordBridgeData): void;
/** Read bridge file from tmpdir. Returns null if missing/corrupt. */
export declare function readCoordBridge(sessionId: string): CoordBridgeData | null;
/**
 * Pick the most recently updated session across maestro and coordinate types.
 * Compares file mtime to determine which is newest.
 */
export declare function readLatestSession(workspaceRoot: string, existingBridge?: CoordBridgeData | null, 
/**
 * Already-computed `readMaestroSession` result, if the caller has one. Pass
 * `null` to say "computed, found nothing" — callers that check it first would
 * otherwise pay the whole session scan twice for the same answer. Omit to let
 * this function do the scan itself.
 */
maestroSession?: CoordBridgeData | null): CoordBridgeData | null;
/**
 * Build a "next step" hint string for additionalContext injection.
 * Returns null if session is completed/failed or has no next step.
 */
export declare function buildNextStepHint(data: CoordBridgeData): string | null;
