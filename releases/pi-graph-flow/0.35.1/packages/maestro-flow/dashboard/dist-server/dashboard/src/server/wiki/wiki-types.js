export function isWikiEntryApplicable(entry, targetRepoId) {
    const explicit = entry.appliesToRepoIds;
    const fallback = Array.isArray(entry.ext?.appliesToRepoIds)
        ? entry.ext.appliesToRepoIds.filter((value) => typeof value === 'string')
        : undefined;
    const appliesToRepoIds = explicit ?? fallback;
    // Historical entries had no applicability field. They retain legacy visibility.
    if (appliesToRepoIds === undefined || appliesToRepoIds === null)
        return true;
    if (!targetRepoId || targetRepoId === '__legacy__')
        return false;
    return appliesToRepoIds.includes(targetRepoId);
}
export function matchesWikiRepository(entry, filters) {
    if (filters.repoId && (entry.repoId ?? entry.source.repoId) !== filters.repoId)
        return false;
    if (filters.repoAlias && (entry.alias ?? entry.source.alias) !== filters.repoAlias)
        return false;
    if (filters.applicableRepoId !== undefined
        && !isWikiEntryApplicable(entry, filters.applicableRepoId))
        return false;
    return true;
}
export const recallSnapshotSchema = z.object({
    schema_version: z.literal('wiki-recall-snapshot/1.0'),
    query: z.string().min(1),
    as_of: z.string().datetime(),
    automatic: z.literal(false),
    mutation_authorized: z.literal(false),
    scoring: z.object({
        provider: z.literal('bm25'),
        embedding_weight_bp: z.literal(0),
        tie_break: z.literal('entry_id_asc'),
    }).strict(),
    candidates: z.array(z.object({
        entry_id: z.string().min(1),
        score_bp: z.number().int().nonnegative(),
        raw_bm25: z.number().finite().nonnegative(),
        source_workspace: z.string().min(1).nullable(),
        workspace_fence: z.string().min(1),
        fork_authorized: z.literal(false),
        resume_authorized: z.literal(false),
    }).strict()),
}).strict();
import { z } from 'zod';
//# sourceMappingURL=wiki-types.js.map