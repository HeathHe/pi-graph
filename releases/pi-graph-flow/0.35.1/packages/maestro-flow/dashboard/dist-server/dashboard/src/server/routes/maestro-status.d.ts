import { Hono } from 'hono';
export interface MaestroRunSummary {
    run_id: string;
    sequence: number | null;
    status: string;
    verdict: string | null;
    command: string | null;
    platform: string | null;
    actor_id: string | null;
    summary: string | null;
    created_at: string | null;
    started_at: string | null;
    ended_at: string | null;
    completed_at: string | null;
}
export interface MaestroSessionSummary {
    session_id: string;
    intent: string | null;
    status: string;
    active_run_ids: string[];
    active_run_id: string | null;
    latest_completed_run_id: string | null;
    created_at: string | null;
    updated_at: string | null;
    run_count: number;
    latest_run: MaestroRunSummary | null;
}
export interface MaestroStatusResponse {
    project: {
        project_name: string | null;
        status: string | null;
        active_session_id: string | null;
        last_updated: string | null;
    };
    sessions: MaestroSessionSummary[];
    knowledge: {
        specs: number;
        memory: number;
        knowhow: number;
        learning_rows: number;
        issue_rows: number;
        total: number;
    };
    generated_at: string;
}
export declare function createMaestroStatusRoutes(workflowRoot: string | (() => string)): Hono;
