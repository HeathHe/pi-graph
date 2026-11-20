import type { DatabaseConnection } from './connection.js';
export declare const CURRENT_SCHEMA_VERSION = 1;
export declare function needsMigration(conn: DatabaseConnection): boolean;
export declare function runMigrations(conn: DatabaseConnection): void;
//# sourceMappingURL=migrations.d.ts.map