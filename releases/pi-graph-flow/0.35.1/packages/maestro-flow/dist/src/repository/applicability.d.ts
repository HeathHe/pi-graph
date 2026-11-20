export interface RepositoryApplicableEntry {
    appliesToRepoIds?: string[] | null;
    ext?: Record<string, unknown>;
}
/**
 * Historical entries without an applicability field remain visible. Scoped
 * entries require an exact persisted target repository ID.
 */
export declare function isRepositoryApplicable(entry: RepositoryApplicableEntry, targetRepoId: string | null | undefined): boolean;
//# sourceMappingURL=applicability.d.ts.map