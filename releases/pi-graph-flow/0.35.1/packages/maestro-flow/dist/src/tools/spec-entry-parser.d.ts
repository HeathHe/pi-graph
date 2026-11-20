/**
 * Spec Entry Parser
 *
 * Parses `<spec-entry>` closed-tag blocks from spec markdown files.
 * Supports dual-format: new `<spec-entry>` tags + legacy heading-based entries.
 */
import { type CanonicalKnowledgeCategory, type KnowledgeLifecycleStatus } from '../utils/frontmatter.js';
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'contested';
export declare const VALID_CONFIDENCE_LEVELS: readonly ConfidenceLevel[];
/**
 * Lifecycle status of a spec entry.
 * - `active` (default): live knowledge, injected and searchable normally.
 * - `deprecated`: superseded by a newer entry; excluded from search/load by
 *   default but preserved for the evolution chain (see `superseded-by`).
 *
 * Orthogonal to `confidence`: status = "is this the current version",
 * confidence = "is this content trusted/contested". A deprecated entry can
 * still have had high confidence; a contested entry is still active.
 */
export type SpecStatus = 'active' | 'deprecated';
export declare const VALID_STATUS: readonly SpecStatus[];
export interface SpecEntryParsed {
    category: string;
    keywords: string[];
    date: string;
    sourceRef?: string;
    /** Legacy compatibility alias for sourceRef. */
    source?: string;
    ref?: string;
    relatedPaths: string[];
    appliesToRepoIds: string[];
    description?: string;
    domain?: string;
    confidence?: ConfidenceLevel;
    conflictMarker?: string;
    conflictNote?: string;
    /** Date (YYYY-MM-DD) the conflict was marked — tracks contested age separately from the entry's creation date. */
    conflictDate?: string;
    /** Stable identity (S-YYYYMMDD-xxxx), survives line-number drift. Anchors the evolution chain. */
    sid?: string;
    /** sid(s) of the entry this one replaces — comma-separated when one entry merges several (this is the newer version). */
    supersedes?: string;
    /** sid of the entry that replaced this one (this is the older version). */
    supersededBy?: string;
    /** Canonical lifecycle status; absent legacy status normalizes to active. */
    lifecycleStatus?: KnowledgeLifecycleStatus;
    /** Legacy compatibility alias for lifecycleStatus. */
    status?: SpecStatus;
    title: string;
    content: string;
    lineStart: number;
    lineEnd: number;
}
export interface ParseResult {
    entries: SpecEntryParsed[];
    legacy: LegacyEntry[];
    errors: ParseError[];
}
export interface LegacyEntry {
    title: string;
    content: string;
    lineStart: number;
}
export interface ParseError {
    line: number;
    message: string;
}
export declare const VALID_CATEGORIES: readonly ["coding", "arch", "debug", "test", "review", "learning", "ui"];
export type ValidCategory = CanonicalKnowledgeCategory;
/**
 * Parse spec file content into structured entries.
 * Returns new-format `<spec-entry>` entries, legacy heading entries, and any errors.
 */
export declare function parseSpecEntries(content: string): ParseResult;
/**
 * Validate a single parsed entry. Returns array of error messages (empty = valid).
 */
export declare function validateSpecEntry(entry: SpecEntryParsed): string[];
/**
 * Validate that entry category matches the expected file category.
 */
export declare function validateCategoryMatch(entry: SpecEntryParsed, fileCategory: string): string | null;
/**
 * Format parsed entries for display output.
 * Strips `<spec-entry>` tags, shows clean content.
 * If keyword provided, highlights matched entries.
 */
export declare function formatSpecEntries(entries: SpecEntryParsed[], keyword?: string): string;
/**
 * Lifecycle metadata for a spec entry. Passed as an options bag to
 * `formatNewEntry` so the evolution chain can be written without exploding the
 * positional parameter list.
 */
export interface SpecEntryLifecycle {
    /** Stable identity; if omitted, none is written (legacy behavior). */
    sid?: string;
    /** sid of the entry this one replaces. */
    supersedes?: string;
    /** sid of the entry that replaced this one. */
    supersededBy?: string;
    /** Lifecycle status; `active` (or omitted) writes no attribute. */
    status?: SpecStatus;
    /** Canonical project-relative paths related to this entry. */
    relatedPaths?: string[];
    /** Canonical persisted repository IDs to which this entry applies. */
    appliesToRepoIds?: string[];
}
/**
 * Generate a stable spec-entry identity: `S-YYYYMMDD-xxxx`.
 * Mirrors the conflict-marker ID scheme. Assigned at `spec add` time so
 * supersedes/superseded-by references survive line-number drift.
 */
export declare function generateSid(now?: Date): string;
/**
 * Format a single entry for writing to a spec file.
 * Writes `category=` attribute as the primary classifier.
 */
export declare function formatNewEntry(category: string, keywords: string[], date: string, title: string, content: string, source?: string, ref?: string, description?: string, confidence?: ConfidenceLevel, conflictMarker?: string, conflictNote?: string, lifecycle?: SpecEntryLifecycle): string;
//# sourceMappingURL=spec-entry-parser.d.ts.map