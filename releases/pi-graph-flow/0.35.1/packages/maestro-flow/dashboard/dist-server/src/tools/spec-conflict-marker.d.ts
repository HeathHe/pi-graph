/**
 * Spec Conflict Marker
 *
 * Mark, clear, and list conflict annotations on <spec-entry> tags.
 * Used by agents during search (mark conflicts) and by audit commands (clear conflicts).
 *
 * Conflict flow:
 *   1. Agent search → detects knowledge conflict → markConflict()
 *   2. Injection → entries with confidence="contested" show warnings, sorted last
 *   3. /maestro-knowledge audit → reviews marks → clearConflict() or setConfidence()
 */
import { type ConfidenceLevel } from './spec-entry-parser.js';
export interface ConflictMark {
    file: string;
    lineStart: number;
    title: string;
    category: string;
    confidence: ConfidenceLevel;
    conflictMarker?: string;
    conflictNote?: string;
    date: string;
}
export interface MarkConflictOptions {
    marker?: string;
    note: string;
    confidence?: ConfidenceLevel;
}
export interface MarkResult {
    success: boolean;
    error?: string;
}
/**
 * All spec scope directories that may hold entries: project baseline, global
 * (~/.maestro/specs), team shared, and personal ({uid} subdirectories).
 * Only existing directories are returned. sid-based functions (supersede,
 * history, health, backfill) iterate these so global/team/personal entries
 * participate in the lifecycle; file+line based functions stay project-scoped
 * because their callers pass paths relative to `.workflow/specs/`.
 */
export declare function specDirs(projectPath: string): string[];
/**
 * Mark a spec entry as conflicted by injecting conflict attributes into its tag.
 */
export declare function markConflict(projectPath: string, file: string, lineStart: number, options: MarkConflictOptions): MarkResult;
/**
 * Clear conflict markers from a spec entry, optionally setting a new confidence level.
 */
export declare function clearConflict(projectPath: string, file: string, lineStart: number, newConfidence?: ConfidenceLevel): MarkResult;
/**
 * Set confidence level on a spec entry without modifying conflict markers.
 */
export declare function setConfidence(projectPath: string, file: string, lineStart: number, confidence: ConfidenceLevel): MarkResult;
/**
 * List all entries with conflict markers or degraded confidence across all spec files.
 */
export declare function listConflicts(projectPath: string): ConflictMark[];
/**
 * Bulk clear all conflict markers in a spec file.
 */
export declare function clearAllConflicts(projectPath: string, file: string, newConfidence?: ConfidenceLevel): {
    cleared: number;
    errors: string[];
};
export interface EvolutionLink {
    sid: string;
    file: string;
    title: string;
    status: ConfidenceLevel | 'active' | 'deprecated' | string;
    date: string;
    current: boolean;
    /** True on a deprecated chain head — its successor no longer exists (broken chain). */
    broken?: boolean;
}
/**
 * Mark the entry identified by `oldSid` as superseded by `newSid`:
 * sets `status="deprecated"` + `superseded-by="<newSid>"` on its tag line.
 *
 * Locates the entry by matching the `sid="..."` attribute directly on the
 * `<spec-entry>` opening line, so it is immune to frontmatter/line-number
 * drift (unlike the line-based conflict marker).
 */
export declare function supersedeEntry(projectPath: string, oldSid: string, newSid: string): MarkResult;
/**
 * Reconstruct the full evolution chain (oldest → newest) that `sid` belongs to.
 * Walks `supersedes` backward to the root and `superseded-by` forward to the
 * head. Returns an ordered list; empty when `sid` is unknown.
 */
export declare function getEvolutionChain(projectPath: string, sid: string): EvolutionLink[];
export interface SpecHealthReport {
    total: number;
    active: number;
    deprecated: number;
    contested: number;
    lowConfidence: number;
    withSid: number;
    withoutSid: number;
    /** Number of evolution chains with more than one version. */
    chains: number;
    /** Entries whose `supersedes` points at a sid that no longer exists. */
    danglingSupersedes: Array<{
        sid: string;
        target: string;
        file: string;
    }>;
    /** Entries whose `superseded-by` points at a sid that no longer exists (successor deleted). */
    danglingSupersededBy: Array<{
        sid: string;
        target: string;
        file: string;
    }>;
    /** sids participating in a supersedes cycle. */
    cyclicSids: string[];
    /** Contested entries whose conflict-date is older than 30 days (entries without conflict-date are skipped). */
    contestedStale: number;
    /** Mean time-decay factor across active entries (1 = all fresh, →floor = stale). */
    avgFreshness: number;
    /** Active entries whose freshness has decayed below the 0.5 warning threshold. */
    staleActive: number;
}
/**
 * Compute a knowledge-health report over all spec entries.
 *
 * Read-only observability for the gardener: it never mutates files — low
 * freshness is *reported*, not auto-downgraded (that stays a human/audit call,
 * keeping confidence and time-decay as separate concerns).
 */
export declare function analyzeSpecHealth(projectPath: string, nowMs?: number): SpecHealthReport;
/**
 * Assign a stable `sid` to every `<spec-entry>` that lacks one. Legacy entries
 * predate the identity scheme; backfilling lets them join supersession chains.
 * Idempotent — entries that already carry a sid are skipped.
 */
export declare function backfillSids(projectPath: string, now?: Date): {
    updated: number;
};
