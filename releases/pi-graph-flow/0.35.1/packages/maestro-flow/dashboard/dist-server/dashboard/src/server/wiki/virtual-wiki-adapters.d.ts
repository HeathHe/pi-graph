import type { WikiEntry } from './wiki-types.js';
export declare function adaptIssueRow(row: unknown, sourcePath: string, line: number): WikiEntry | null;
export declare function loadVirtualEntries(absPath: string, adapter: (row: unknown, sourcePath: string, line: number) => WikiEntry | null, relPath: string): Promise<WikiEntry[]>;
export declare function loadVirtualJsonEntries(absPath: string, adapter: (parsed: unknown, sourcePath: string) => WikiEntry[], relPath: string): Promise<WikiEntry[]>;
export interface KgAdapterOptions {
    maxRelatedPerNode: number;
    maxSummaryLength: number;
    maxTags: number;
}
export declare function adaptKnowledgeGraph(parsed: unknown, sourcePath: string, opts?: KgAdapterOptions): WikiEntry[];
/** Read-only Wiki projection of the canonical MaestroGraph SQLite database. */
export declare function adaptKnowledgeGraphFromDb(dbPath: string, sourcePath: string, opts?: KgAdapterOptions): WikiEntry[];
/**
 * Cross-reference KG entries with existing codebase doc-index entries.
 * Matches by filePath → code_locations. Mutates kgEntries in place.
 */
export declare function crossReferenceKgWithDocIndex(kgEntries: WikiEntry[], docIndexEntries: WikiEntry[]): void;
export declare function adaptCodebaseDocIndex(parsed: unknown, sourcePath: string): WikiEntry[];
/** Load a run-mode session and its sealed runs without indexing draft projections. */
export declare function loadRunModeSessionEntries(sessionAbsPath: string, sessionRelPath: string, allowedRoot?: string): Promise<WikiEntry[]>;
export declare function adaptClaudeCodeSession(jsonlLines: string[], sourcePath: string, projectSlug: string): WikiEntry | null;
export declare function loadClaudeCodeSessions(projectDir: string, projectSlug: string, maxAgeDays: number, maxFiles: number): Promise<WikiEntry[]>;
export declare function adaptCodexSession(jsonlLines: string[], sourcePath: string, threadName: string | null): WikiEntry | null;
export interface CodexSessionIndex {
    id: string;
    threadName: string;
    updatedAt: string;
}
export declare function loadCodexSessionIndex(codexRoot: string): Promise<Map<string, string>>;
export declare function loadCodexSessions(codexRoot: string, projectCwd: string, maxAgeDays: number, maxFiles: number): Promise<WikiEntry[]>;
export declare function cwdToClaudeProjectSlug(cwd: string): string;
