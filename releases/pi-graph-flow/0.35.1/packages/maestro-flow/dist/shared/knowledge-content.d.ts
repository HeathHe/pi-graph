/**
 * Canonical Knowhow/Spec content parameters and legacy read normalization.
 *
 * This module deliberately has no Node or dashboard dependencies so every
 * parser, writer, indexer, and extractor can use the same mapping rules.
 */
export declare const CANONICAL_KNOWLEDGE_CATEGORIES: readonly ["coding", "arch", "debug", "test", "review", "learning", "ui"];
export type CanonicalKnowledgeCategory = (typeof CANONICAL_KNOWLEDGE_CATEGORIES)[number];
export declare const KNOWHOW_TYPES: readonly ["session", "tip", "template", "recipe", "reference", "decision", "asset", "blueprint", "document"];
export type CanonicalKnowhowType = (typeof KNOWHOW_TYPES)[number];
export declare const DECISION_STATES: readonly ["proposed", "accepted", "superseded"];
export type DecisionState = (typeof DECISION_STATES)[number];
export declare const LIFECYCLE_STATUSES: readonly ["active", "deprecated"];
export type KnowledgeLifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export interface CanonicalContentInput extends Record<string, unknown> {
    title?: unknown;
    content?: unknown;
    body?: unknown;
    keywords?: unknown;
    tags?: unknown;
    category?: unknown;
    specCategory?: unknown;
    sourceRef?: unknown;
    source?: unknown;
    relatedPaths?: unknown;
    codePaths?: unknown;
    appliesToRepoIds?: unknown;
    type?: unknown;
    language?: unknown;
    lang?: unknown;
    decisionState?: unknown;
    lifecycleStatus?: unknown;
    status?: unknown;
    tool?: unknown;
    explicitId?: unknown;
    assetType?: unknown;
    description?: unknown;
    summary?: unknown;
}
export interface CanonicalKnowledgeContent {
    title: string;
    content: string;
    keywords: string[];
    category: CanonicalKnowledgeCategory | null;
    sourceRef: string | null;
    relatedPaths: string[];
    appliesToRepoIds: string[];
    summary: string;
    type: CanonicalKnowhowType | null;
    language: string | null;
    decisionState: DecisionState | null;
    lifecycleStatus: KnowledgeLifecycleStatus;
    tool: boolean;
    explicitId: string | null;
    /** Non-fatal legacy ambiguities retained for audit surfaces. */
    auditMarkers: string[];
    /** Invalid canonical values. Writers must reject when this is non-empty. */
    errors: string[];
}
export declare function isCanonicalKnowledgeCategory(value: unknown): value is CanonicalKnowledgeCategory;
/** Normalize and validate a project-relative related path. */
export declare function normalizeRelatedPath(value: string): string;
/**
 * Pick the first useful prose paragraph. Markdown headings, fenced markers,
 * and standalone XML tags are skipped so summaries describe actual content.
 */
export declare function deriveContentSummary(content: string, maxLength?: number): string;
/**
 * Normalize canonical fields while dual-reading every supported legacy alias.
 * Invalid legacy values are never silently promoted into canonical fields.
 */
export declare function normalizeCanonicalKnowledgeContent(input: CanonicalContentInput): CanonicalKnowledgeContent;
//# sourceMappingURL=knowledge-content.d.ts.map