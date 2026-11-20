/**
 * Spec Keyword Index
 *
 * Builds an inverted index from keyword → spec entries.
 * Scans all `.workflow/specs/*.md` files, parses <spec-entry> tags,
 * and indexes by keyword for fast lookup.
 */
export interface IndexedEntry {
    file: string;
    category: string;
    keywords: string[];
    content: string;
    title: string;
    id: string;
    confidence?: string;
    conflictMarker?: string;
}
/**
 * Build a keyword → entries inverted index from all spec files.
 * Each keyword maps to an array of matching entries.
 */
export declare function buildKeywordIndex(projectPath: string, applicableRepoId?: string | null): Map<string, IndexedEntry[]>;
/**
 * Look up entries matching a keyword.
 */
export declare function lookupKeyword(index: Map<string, IndexedEntry[]>, keyword: string): IndexedEntry[];
/**
 * Look up entries matching any of the given keywords.
 * Returns deduplicated entries (by id).
 */
export declare function lookupKeywords(index: Map<string, IndexedEntry[]>, keywords: string[]): IndexedEntry[];
//# sourceMappingURL=spec-keyword-index.d.ts.map