/**
 * Shared lifecycle policy for Wiki-backed knowledge entries.
 *
 * Some paths consume the full WikiEntry while hot-path hooks consume the
 * persisted lightweight index. Accept both shapes so deprecated knowledge is
 * hidden consistently across search, load, and prompt injection.
 */
export interface KnowledgeLifecycleEntry {
    status?: unknown;
    ext?: unknown;
}
export declare function getKnowledgeStatus(entry: KnowledgeLifecycleEntry): string | null;
export declare function isDeprecatedKnowledgeEntry(entry: KnowledgeLifecycleEntry): boolean;
