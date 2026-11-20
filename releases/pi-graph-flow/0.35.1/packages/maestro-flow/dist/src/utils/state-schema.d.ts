/**
 * state-schema.ts — Canonical state.json v2 types, derivation, migration, and I/O.
 *
 * Single source of truth for the `.workflow/state.json` schema.
 * All hooks, tools, and workflows should import from here.
 */
/**
 * Cross-platform atomic rename with bounded retry for Windows transient errors.
 * The committed destination is never unlinked before a successful promotion;
 * callers that need crash recovery must retain a durable transaction intent.
 */
export declare function safeRename(src: string, dest: string): void;
/** Local-time ISO 8601 string with timezone offset, e.g. "2026-04-24T14:30:00+08:00" */
export declare function localISO(): string;
export type ProjectStatus = 'idle' | 'active' | 'executing' | 'completed';
export type ArtifactType = 'analyze' | 'plan' | 'execute' | 'verify' | 'brainstorm' | 'spec' | 'review' | 'debug' | 'test';
export type ArtifactScope = 'milestone' | 'phase' | 'adhoc' | 'standalone';
export type ArtifactStatus = 'pending' | 'in_progress' | 'completed' | 'failed';
export interface ArtifactEntry {
    id: string;
    type: ArtifactType;
    milestone: string | null;
    phase: number | null;
    scope: ArtifactScope;
    path: string;
    status: ArtifactStatus;
    depends_on: string | string[] | null;
    harvested: boolean;
    error_context?: string | null;
    created_at: string;
    completed_at: string | null;
}
export interface MilestoneEntry {
    id: string;
    name: string;
    title: string;
    status: 'pending' | 'active' | 'completed';
    phases: number[];
    /** v3.1 extension: milestone type discriminator. */
    type?: 'standard' | 'adhoc';
    /** v3.1 extension: phase number → slug mapping. */
    phase_slugs?: Record<number, string>;
    /** v3.1 extension: reference to the roadmap artifact that defined this milestone. */
    roadmap_ref?: string | null;
    /** v3.1 extension: ISO timestamp when the milestone was created. */
    created_at?: string;
}
export interface DeferredItem {
    id?: string;
    severity?: string;
    fix_direction?: string;
    description?: string;
}
export interface TransitionSnapshot {
    phases_completed: number;
    phases_total: number;
    deferred_count: number;
    verification_status: string;
    learnings_count: number;
}
export interface TransitionEntry {
    type: 'phase' | 'milestone';
    from_phase: number | null;
    to_phase: number | null;
    milestone: string;
    transitioned_at: string;
    trigger: string;
    force: boolean;
    snapshot: TransitionSnapshot;
}
export interface MilestoneHistoryEntry {
    id: string;
    name: string;
    slug?: string;
    status: string;
    completed_at: string | null;
    phases?: number[];
    audit_verdict?: string | null;
    force_completed?: boolean;
    archive_path?: string | null;
    archived_artifacts?: ArtifactEntry[];
}
export interface ProjectSessionEntry {
    session_id: string;
    intent: string;
    /** Discriminator for authoritative fields in this projection entry. */
    session_schema_version?: 'session/1.0' | 'session/1.1' | 'session/1.2' | 'session/1.3' | 'session/2.0';
    /** session/1.x lifecycle authority. Absent for statusless session/2.0. */
    status?: 'planned' | 'running' | 'paused' | 'sealed' | 'archived' | 'failed';
    /** session/1.x active Run authority. Absent for statusless session/2.0. */
    active_run_id?: string | null;
    /** session/2.0 current Execution pointer. Absent for session/1.x. */
    current_execution_id?: string | null;
    /** session/2.0 historical Execution pointer. Absent for session/1.x. */
    latest_execution_id?: string | null;
    /** session/2.0 archive marker. Absent for session/1.x. */
    archived_at?: string | null;
    depends_on: string[];
    roadmap_artifact_id: string | null;
    seed_ref: string | null;
    /** ISO timestamp of the last session next/done activity (multi-session fast path). */
    last_activity?: string;
}
export interface StateJsonV2 {
    version: string;
    project_name: string | null;
    status: ProjectStatus;
    current_milestone: string | null;
    current_task_id: string | null;
    milestones: MilestoneEntry[];
    artifacts: ArtifactEntry[];
    accumulated_context: {
        key_decisions: string[];
        blockers: string[];
        deferred: Array<DeferredItem | string>;
    };
    transition_history: TransitionEntry[];
    milestone_history: MilestoneHistoryEntry[];
    last_updated: string;
    /** Active canonical Session pointer. */
    active_session_id?: string | null;
    /** Canonical Session DAG projection. */
    sessions?: ProjectSessionEntry[];
    /** v3.1 extension: human-readable schema hint for milestone entries. */
    _milestone_schema?: string;
    /** v3.1 extension: derived current phase (kept for backward compat). */
    current_phase?: number | null;
    /** v3.1 extension: derived phases summary (kept for backward compat). */
    phases_summary?: PhasesSummary;
    /** Catch-all for forward-compatible fields from newer schema versions. */
    [key: string]: unknown;
}
export interface PhasesSummary {
    total: number;
    completed: number;
    in_progress: number;
    pending: number;
}
/**
 * Derive the "current phase" from artifact registry.
 * Priority: phase with in_progress artifact → first phase without completed execute.
 */
export declare function deriveCurrentPhase(state: StateJsonV2): number | null;
/**
 * Derive phases_summary from artifact registry.
 */
export declare function derivePhasesSummary(state: StateJsonV2): PhasesSummary;
export declare function nextArtifactId(artifacts: ArtifactEntry[], type: ArtifactType): string;
interface V1State {
    version?: string;
    project_name?: string;
    current_milestone?: string;
    current_phase?: number;
    status?: string;
    phases_summary?: {
        total: number;
        completed: number;
        in_progress: number;
        pending: number;
    };
    milestones?: Array<{
        name: string;
        title?: string;
        phases?: number[];
        id?: string;
        status?: string;
    }>;
    artifacts?: ArtifactEntry[];
    accumulated_context?: StateJsonV2['accumulated_context'];
    transition_history?: unknown[];
    milestone_history?: unknown[];
    last_updated?: string;
    current_task_id?: string | null;
    [key: string]: unknown;
}
/**
 * Migrate v1 state.json to v2. Optionally harvests legacy phases/ artifacts.
 */
export declare function migrateV1toV2(raw: V1State, workflowRoot?: string): StateJsonV2;
/**
 * Read state.json from a workspace. Auto-migrates v1 to v2 in memory (does not write back).
 * Returns null if file doesn't exist.
 */
export declare function readStateJson(workflowRoot: string): StateJsonV2 | null;
/**
 * Write state.json atomically (write-tmp + rename).
 */
export declare function writeStateJson(workflowRoot: string, state: StateJsonV2): void;
/**
 * Read, migrate if needed, and write back v2 state.json.
 * Returns the migrated state. Use this for one-shot migration.
 */
export declare function migrateStateFile(workflowRoot: string): StateJsonV2 | null;
/** Ensure state.json carries the canonical Session DAG projection. */
export declare function ensureSessionProjection(state: StateJsonV2, session: ProjectSessionEntry, makeActive?: boolean): StateJsonV2;
export {};
//# sourceMappingURL=state-schema.d.ts.map