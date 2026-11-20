import { type ResolvedSession } from './session-resolver.js';
export interface GraphChainStep {
    index: number;
    step_id: string;
    command: string;
    status: string;
    run_id: string | null;
    decision_ref: string | null;
    stage: string | null;
    goal_ref: string | null;
    active: boolean;
}
export interface GraphDecision {
    point_id: string;
    status: string;
    after_step_id: string | null;
    retry_count: number;
    max_retries: number;
    evidence_ref: string | null;
}
export interface GraphGoal {
    id: string;
    goal: string;
    status: string;
    done_when: string | null;
}
export interface GraphResult {
    session_id: string;
    intent: string;
    status: string;
    engine: string;
    quality_mode: string;
    progress: {
        sealed: number;
        running: number;
        pending: number;
        total: number;
    };
    chain: GraphChainStep[];
    decisions: GraphDecision[];
    goals: GraphGoal[];
    position: {
        lifecycle: string;
        phase: number | null;
        phase_is_new: boolean;
        milestone: string;
        planning_mode: string | null;
        scope_verdict: string | null;
    } | null;
    continuation: {
        action: string;
        command: string | null;
        reason: string;
    };
}
export declare function buildGraph(projectRoot: string, sessionId?: string): GraphResult;
export declare function buildGraphFromResolved(projectRoot: string, resolved: ResolvedSession): GraphResult;
export declare function renderGraphHuman(graph: GraphResult): string;
//# sourceMappingURL=graph.d.ts.map