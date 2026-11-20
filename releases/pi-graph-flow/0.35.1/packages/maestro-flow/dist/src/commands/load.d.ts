/**
 * Load Command — Unified knowledge loading (specs, wiki, sessions).
 *
 *   maestro load <id>                              — load by canonical ID (type inferred)
 *   maestro load --type session --list             — list recent sessions
 *   maestro load --type session --id <id>          — load specific session
 *   maestro load --type spec --category coding     — load coding specs
 *   maestro load --type knowhow --list             — browse knowhow entries
 *   maestro load --type knowhow --id <id>          — load specific knowhow
 */
import type { Command } from 'commander';
import type { WikiIndexer } from '#maestro-dashboard/wiki/wiki-indexer.js';
import type { WikiEntry, WikiIndex } from '#maestro-dashboard/wiki/wiki-types.js';
declare const VALID_TYPES: readonly ["spec", "knowhow", "note", "domain", "issue", "project", "roadmap", "session", "scratch", "template"];
type LoadType = (typeof VALID_TYPES)[number];
/** Run one operation while holding the cached reader's lifecycle lease. */
export declare function withWikiIndexer<T>(projectRoot: string | undefined, operation: (indexer: WikiIndexer) => Promise<T>): Promise<T>;
/**
 * Resolve an entry ID with tolerance: exact match first, then
 * case-insensitive, then with the `--type` prefix applied (e.g. `--id dcs-…`
 * matches `knowhow-dcs-…`). When no type is given (wiki load/get), all known
 * type prefixes are tried. Mirrors the lowercase canonical IDs produced by
 * knowhowFileToWikiId() so hand-typed IDs don't miss.
 */
export declare function findEntry(index: WikiIndex, rawId: string, type?: LoadType): WikiEntry | null;
export declare function recordLoadedKnowledge(entries: WikiEntry[]): Promise<void>;
export declare function registerLoadCommand(program: Command): void;
export {};
//# sourceMappingURL=load.d.ts.map