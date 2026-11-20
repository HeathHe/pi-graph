/**
 * Historical entries without an applicability field remain visible. Scoped
 * entries require an exact persisted target repository ID.
 */
export function isRepositoryApplicable(entry, targetRepoId) {
    const fallback = Array.isArray(entry.ext?.appliesToRepoIds)
        ? entry.ext.appliesToRepoIds.filter((value) => typeof value === 'string')
        : undefined;
    const appliesToRepoIds = entry.appliesToRepoIds ?? fallback;
    if (appliesToRepoIds === undefined || appliesToRepoIds === null)
        return true;
    if (!targetRepoId || targetRepoId === '__legacy__')
        return false;
    return appliesToRepoIds.includes(targetRepoId);
}
//# sourceMappingURL=applicability.js.map