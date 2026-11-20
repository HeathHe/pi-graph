export type MaestroSessionSource = 'ralph' | 'maestro' | 'coordinate';
export interface RalphStep {
    index: number;
    type: 'internal' | 'external' | 'decision';
    skill: string;
    args: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    error?: string;
    retried?: boolean;
    completion_status?: 'DONE' | 'DONE_WITH_CONCERNS' | 'NEEDS_RETRY' | 'BLOCKED' | null;
    completion_confirmed?: boolean;
    retry_count?: number;
    max_retries?: number;
}
export interface MaestroStep {
    index: number;
    type: 'skill' | 'cli' | 'decision';
    skill: string;
    args: string;
    status?: string;
    started_at?: string;
    completed_at?: string;
    error?: string;
}
export interface CoordHistoryEntry {
    node_id: string;
    node_type: string;
    outcome?: string;
    summary?: string;
    entered_at?: string;
    exited_at?: string;
    exec_id?: string;
    quality_score?: number;
}
export interface RalphStatusJson {
    session_id: string;
    source: 'ralph';
    created_at: string;
    updated_at: string;
    intent: string;
    status: string;
    chain_name: string;
    task_type: string;
    lifecycle_position: string;
    target: string;
    phase: number | null;
    milestone: string;
    auto_mode: boolean;
    cli_tool: string;
    quality_mode: string;
    passed_gates: string[];
    context: {
        issue_id: string | null;
        milestone_num: number | null;
        spec_session_id: string | null;
        scratch_dir: string | null;
        plan_dir: string | null;
        analysis_dir: string | null;
        brainstorm_dir: string | null;
    };
    steps: RalphStep[];
    waves: unknown[];
    current_step: number;
}
export interface MaestroStatusJson {
    session_id: string;
    source: 'maestro';
    created_at: string;
    updated_at: string;
    intent: string;
    status: string;
    chain_name: string;
    task_type: string;
    phase: number | null;
    milestone?: string;
    auto_mode: boolean;
    steps: MaestroStep[];
    current_step: number;
}
export interface CoordinateWalkerState {
    session_id: string;
    graph_id: string;
    current_node: string;
    status: string;
    intent: string;
    auto_mode?: boolean;
    tool?: string;
    context?: {
        project?: {
            current_phase: number;
        };
        inputs?: Record<string, string>;
    };
    history: CoordHistoryEntry[];
    created_at: string;
    updated_at: string;
}
export interface MaestroSessionListItem {
    dirName: string;
    source: MaestroSessionSource;
    sessionId: string;
    intent: string;
    status: string;
    chainName: string | null;
    /** Ralph-only: current lifecycle position (e.g., "plan", "verify") */
    lifecyclePosition?: string;
    phase: number | null;
    milestone?: string;
    currentStep: number;
    totalSteps: number;
    updatedAt: string;
}
export interface MaestroSessionUpdatedPayload {
    session: MaestroSessionListItem;
}
