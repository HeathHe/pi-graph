import { DatabaseSync } from 'node:sqlite';
import type { Language } from './types.js';
/** applyMigrations 完成后应达到的最新 schema 版本。 */
export declare const KG_SCHEMA_VERSION: 8;
export declare class KgDatabaseConnection {
    private db;
    private dbPath;
    private readOnly;
    get raw(): DatabaseSync;
    get path(): string;
    get isOpen(): boolean;
    /** 初始化 — 创建 DB + 应用 Schema */
    initialize(dbPath: string): void;
    /** 打开已有 DB */
    open(dbPath: string): void;
    /** 以 SQLite read-only 模式打开已有 DB，不应用任何 write-like PRAGMA。 */
    openReadOnly(dbPath: string): void;
    close(): void;
    private applyPragmas;
    private loadSchema;
    private setSchemaVersion;
    getSchemaVersion(): number;
    transaction<T>(fn: () => T): T;
    transactionAsync<T>(fn: () => Promise<T>): Promise<T>;
    optimize(): void;
    runMaintenance(): void;
    getSize(): number;
}
export declare function getKgDatabasePath(projectRoot?: string): string;
export { makeNodeId, validateNodeId } from './types.js';
export declare const FILE_LEVEL_ONLY_LANGUAGES: Set<string>;
export declare function isFileLevelOnlyLanguage(lang: Language | string): boolean;
export declare function isKnowledgeSourceType(sourceType: string): boolean;
export declare function sqliteTransaction<T>(db: DatabaseSync, fn: () => T): T;
//# sourceMappingURL=connection.d.ts.map