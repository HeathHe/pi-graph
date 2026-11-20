/**
 * Wiki Category Loader — synchronous wiki knowledge loading by category.
 *
 * Reads the persisted wiki-index.json to quickly load category-tagged
 * entries without requiring the full WikiIndexer or dashboard server.
 * Used by spec-injector hook for lightweight context injection.
 */
export interface WikiCategoryResult {
    content: string;
    entryCount: number;
}
export interface WikiIndexEntry {
    type: string;
    title: string;
    summary: string;
    category?: string | null;
    specCategory?: string | null;
    updated: string;
    status?: string;
    tags?: string[];
    ext?: {
        virtualKind?: string;
        status?: string;
        appliesToRepoIds?: string[];
    };
    repoId?: string | null;
    repoName?: string;
    alias?: string;
    workspaceFence?: string;
    appliesToRepoIds?: string[] | null;
}
export interface ParsedWikiIndex {
    entries?: WikiIndexEntry[];
}
/**
 * Load and parse the persisted wiki index once per mtime. The hook hot path
 * calls this per agent spawn across multiple categories — re-parsing a
 * multi-MB JSON each time is wasted blocking I/O. A stat failure falls back
 * to a fresh read; parse failures are cached as null until the file changes.
 */
export declare function loadWikiIndex(projectPath: string): ParsedWikiIndex | null;
/**
 * Select entries matching a given category from a parsed wiki index.
 * Returns formatted title+summary content for injection, or null if
 * no matching entries exist.
 */
export declare function selectWikiByCategory(index: ParsedWikiIndex | null, category: string, applicableRepoId?: string | null): WikiCategoryResult | null;
/**
 * Load wiki entries matching a given category from the persisted index.
 * Thin wrapper over loadWikiIndex + selectWikiByCategory.
 */
export declare function loadWikiByCategory(projectPath: string, category: string, applicableRepoId?: string | null): WikiCategoryResult | null;
//# sourceMappingURL=wiki-role-loader.d.ts.map