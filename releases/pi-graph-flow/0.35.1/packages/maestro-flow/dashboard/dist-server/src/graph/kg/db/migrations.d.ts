import type { KgDatabaseConnection } from './connection.js';
export interface MigrationStep {
    version: number;
    description: string;
    sql: string;
}
export declare function applyMigrations(conn: KgDatabaseConnection): void;
/**
 * 在 migrations 之外重建 FTS 后调用，使下次 applyMigrations 重新验证。
 * (例如 orchestrator.ensureFtsConsistency 重建了 FTS 表。)
 */
export declare function invalidateFtsV8Cache(dbPath: string): void;
