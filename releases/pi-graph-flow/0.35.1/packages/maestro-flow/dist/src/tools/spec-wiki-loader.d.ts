import type { WikiEntry } from '#maestro-dashboard/wiki/wiki-types.js';
import type { RepositoryContext } from '../repository/context.js';
/**
 * Load file-backed spec entries without importing or rebuilding WikiIndexer.
 * The returned projection intentionally matches WikiIndexer's spec IDs and
 * lifecycle metadata so the load command can retain its existing filters.
 */
export declare function loadSpecWikiEntries(repository: RepositoryContext): Promise<WikiEntry[]>;
//# sourceMappingURL=spec-wiki-loader.d.ts.map