import { DatabaseSync } from 'node:sqlite';
export declare class DatabaseConnection {
    private db;
    private dbPath;
    get raw(): DatabaseSync;
    get path(): string;
    get isOpen(): boolean;
    initialize(dbPath: string): void;
    open(dbPath: string): void;
    close(): void;
    private applyPragmas;
    private loadSchema;
    private setSchemaVersion;
    transaction<T>(fn: () => T): T;
    optimize(): void;
    runMaintenance(): void;
    getSize(): number;
    getJournalMode(): string;
    getSchemaVersion(): number;
}
export declare function getDatabasePath(projectRoot?: string): string;
export declare function sqliteTransaction<T>(db: DatabaseSync, fn: () => T): T;
//# sourceMappingURL=connection.d.ts.map