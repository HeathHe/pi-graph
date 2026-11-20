import type { KnowledgeGraph } from './types.js';
export declare function migrateJsonToSqlite(jsonPath?: string, dbPath?: string): {
    nodes: number;
    edges: number;
    dbPath: string;
};
export declare function exportSqliteToJson(dbPath?: string): KnowledgeGraph;
//# sourceMappingURL=migration.d.ts.map