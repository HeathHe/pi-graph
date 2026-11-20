import { type CanonicalContentInput } from '../../shared/knowledge-content.js';
export { CANONICAL_KNOWLEDGE_CATEGORIES, DECISION_STATES, KNOWHOW_TYPES, LIFECYCLE_STATUSES, deriveContentSummary, isCanonicalKnowledgeCategory, normalizeCanonicalKnowledgeContent, normalizeRelatedPath, } from '../../shared/knowledge-content.js';
export type { CanonicalContentInput, CanonicalKnowledgeCategory, CanonicalKnowledgeContent, CanonicalKnowhowType, DecisionState, KnowledgeLifecycleStatus, } from '../../shared/knowledge-content.js';
export declare function parseFrontmatter(raw: string): {
    data: Record<string, any>;
    body: string;
};
export declare function stripFrontmatter(raw: string): string;
export declare function escapeYamlValue(value: string): string;
export declare function slugify(text: string): string;
export declare const KNOWHOW_CATEGORIES: readonly ["session", "tip", "template", "recipe", "reference", "decision", "asset", "blueprint", "document"];
export type KnowHowCategory = (typeof KNOWHOW_CATEGORIES)[number];
export declare const KNOWHOW_PREFIX_MAP: Record<string, string>;
export declare function getKnowhowDir(projectRoot?: string): string;
/**
 * Canonical wiki id for a knowhow file — exactly as WikiIndexer derives it:
 * `knowhow-` + slugified filename stem, type prefix included
 * (e.g. `TIP-20260427-my-slug.md` → `knowhow-tip-20260427-my-slug`).
 */
export declare function knowhowFileToWikiId(filename: string): string;
export interface KnowhowFilename {
    id: string;
    filename: string;
    explicitId: string | null;
}
/**
 * Resolve a knowhow filename from either the legacy clock/title convention or
 * a caller-owned stable stem. Stable stems deliberately include the type
 * prefix and date so their public wiki id and on-disk path never depend on the
 * replay date.
 */
export declare function resolveKnowhowFilename(type: KnowHowCategory, title?: string, explicitId?: string | null): KnowhowFilename;
export declare function generateKnowhowFilename(type: KnowHowCategory, title?: string, explicitId?: string | null): KnowhowFilename;
export interface KnowhowReplayPayloadInput extends CanonicalContentInput {
    [key: string]: unknown;
}
export declare function normalizeKnowhowBody(value: unknown): string | null;
/**
 * Canonical caller-owned equality payload for explicit-ID add replay.
 *
 * Server-owned timestamps, index enrichment and lifecycle fields are ignored
 * by construction: only the fixed keys below enter the canonical bytes.
 */
export declare function normalizeKnowhowReplayPayload(input: KnowhowReplayPayloadInput): {
    canonical: string;
    sha256: string;
};
