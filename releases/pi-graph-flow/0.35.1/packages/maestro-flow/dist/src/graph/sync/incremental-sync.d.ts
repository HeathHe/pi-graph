import type { DatabaseConnection } from '../db/connection.js';
export interface SyncResult {
    filesChanged: number;
    nodesAdded: number;
    edgesAdded: number;
    durationMs: number;
}
export declare class IncrementalSync {
    private projectRoot;
    private conn;
    private queries;
    constructor(projectRoot: string, conn: DatabaseConnection);
    sync(): SyncResult;
    private detectChanges;
    private getGitChangedFiles;
    private classifyGitChanges;
    private getAllSourceFiles;
    private extractFile;
    private extractSymbols;
    private extractImports;
    private resolveImport;
}
//# sourceMappingURL=incremental-sync.d.ts.map