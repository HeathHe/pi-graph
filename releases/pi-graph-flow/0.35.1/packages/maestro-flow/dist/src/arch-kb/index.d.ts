export type ArchKbEntryType = 'template' | 'tutorial' | 'case';
export interface ArchKbEntry {
    id: string;
    type: ArchKbEntryType;
    title: string;
    slug: string;
    summary: string;
    keywords: string[];
    path: string;
    sections: string[];
}
export interface ArchKbIndex {
    version: number;
    builtAt: string;
    source: string;
    license: string;
    stats: {
        templates: number;
        tutorials: number;
        cases: number;
        total: number;
    };
    entries: ArchKbEntry[];
}
export interface ScoredArchKbEntry {
    entry: ArchKbEntry;
    score: number;
}
/** Resolve bundled and installed Arch-KB resource directories. */
export declare function bundledArchKbResourceDirs(): string[];
/** Find the first Arch-KB directory that contains an index. */
export declare function resolveArchKbIndexDir(): string | null;
/** Load the read-only Arch-KB index, returning null when unavailable. */
export declare function loadArchKbIndex(): ArchKbIndex | null;
/** Preserve the dedicated command's existing fail-loudly behavior. */
export declare function requireArchKbIndex(): ArchKbIndex;
/** Resolve an indexed markdown path from installed, bundled, or source resources. */
export declare function resolveArchKbContentPath(relativePath: string): string | null;
export declare function tokenize(text: string): string[];
export declare function scoreArchKbEntry(entry: ArchKbEntry, queryTokens: string[]): number;
export declare function searchArchKbEntriesWithScores(entries: ArchKbEntry[], query: string, opts?: {
    type?: ArchKbEntryType;
    limit?: number;
}): ScoredArchKbEntry[];
export declare function searchArchKbEntries(entries: ArchKbEntry[], query: string, opts?: {
    type?: ArchKbEntryType;
    limit?: number;
}): ArchKbEntry[];
export declare function searchArchKb(query: string, opts?: {
    type?: ArchKbEntryType;
    limit?: number;
}): ScoredArchKbEntry[];
export declare function resetArchKbIndexCache(): void;
//# sourceMappingURL=index.d.ts.map