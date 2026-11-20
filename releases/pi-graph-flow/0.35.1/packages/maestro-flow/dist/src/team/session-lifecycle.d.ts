/**
 * Pure team-session lifecycle classification and resume ranking.
 *
 * This module intentionally has no filesystem or clock dependencies. Callers
 * must supply both `now` and the stale TTL so classification is deterministic.
 */
export declare const TEAM_SESSION_LIFECYCLES: readonly ["active", "paused", "completed", "failed", "abandoned", "archived"];
export type TeamSessionLifecycle = (typeof TEAM_SESSION_LIFECYCLES)[number];
export declare const TEAM_SESSION_HEALTHS: readonly ["fresh", "idle", "stale_candidate", "inconsistent", "unknown"];
export type TeamSessionHealth = (typeof TEAM_SESSION_HEALTHS)[number];
export type TeamRunStatus = 'created' | 'running' | 'blocked' | 'completed' | 'paused' | 'sealed' | 'archived' | 'failed';
export type TimestampInput = string | number | Date | null | undefined;
export interface AuditedAbandonmentTransition {
    /** A durable audit record must explicitly attest the transition. */
    audited: true;
    actor: string;
    reason: string;
    at: TimestampInput;
}
export interface TeamSessionEvidence {
    /** Canonical Run state when the team belongs to a Run. */
    runStatus?: TeamRunStatus | null;
    /** Durable team-session.json lifecycle. */
    sidecarLifecycle?: TeamSessionLifecycle | null;
    /** Compatibility lifecycle from .msg/meta.json. */
    metaLifecycle?: TeamSessionLifecycle | null;
    /** Required whenever either durable source claims `abandoned`. */
    abandonmentTransition?: AuditedAbandonmentTransition | null;
    /** Live evidence; persisted worker names are deliberately excluded. */
    liveBrokerMembers?: number;
    /** False when the broker could not be queried; cleanup then fails closed. */
    livenessKnown?: boolean;
    /** False when durable task state could not be read or validated. */
    taskStateKnown?: boolean;
    nonTerminalTasks?: number;
    /** Informational legacy field. It never proves liveness. */
    persistedActiveWorkers?: number;
    latestMessageAt?: TimestampInput;
    latestTaskAt?: TimestampInput;
    metaUpdatedAt?: TimestampInput;
    sidecarUpdatedAt?: TimestampInput;
    filesystemMtime?: TimestampInput;
}
export interface ClassifyTeamSessionOptions {
    now: TimestampInput;
    staleTtlMs: number;
}
export interface TeamSessionClassification {
    lifecycle: TeamSessionLifecycle;
    health: TeamSessionHealth;
    /** Most recent valid activity timestamp, in epoch milliseconds. */
    lastActivityAt?: number;
    live: boolean;
    cleanupEligible: boolean;
    reasons: string[];
}
export declare function classifyTeamSession(evidence: TeamSessionEvidence, options: ClassifyTeamSessionOptions): TeamSessionClassification;
export interface CleanupEligibilityOptions {
    /** Force can confirm a terminal cleanup, but never changes lifecycle safety. */
    force?: boolean;
}
export interface CleanupEligibility {
    eligible: boolean;
    reason: string;
}
export declare function getTeamSessionCleanupEligibility(classification: TeamSessionClassification, _options?: CleanupEligibilityOptions): CleanupEligibility;
export interface ResumeCandidate {
    sessionId: string;
    runId?: string;
    runDir?: string;
    classification: TeamSessionClassification;
}
export interface ResumeLocator {
    sessionId?: string;
    runId?: string;
    runDir?: string;
}
export interface RankedResumeCandidate extends ResumeCandidate {
    exactLocatorMatch: boolean;
    resumable: boolean;
    tied: boolean;
}
export interface ResumeRanking {
    candidates: RankedResumeCandidate[];
    /** Only an explicit, unique locator may produce an automatic selection. */
    selected?: RankedResumeCandidate;
    requiresUserSelection: boolean;
    reason: 'exact_locator' | 'locator_not_found' | 'locator_ambiguous' | 'manual_selection';
}
export declare function rankResumeCandidates(candidates: readonly ResumeCandidate[], locator?: ResumeLocator): ResumeRanking;
//# sourceMappingURL=session-lifecycle.d.ts.map