import type { KnowledgeGraph } from './types.js';
import { DatabaseConnection } from './db/connection.js';
import { QueryBuilder } from './db/queries.js';
export type DetectedBackend = 'sqlite' | 'json' | 'none';
export declare function loadGraph(kgPath?: string): KnowledgeGraph;
export declare function loadGraphSqlite(projectRoot?: string): {
    conn: DatabaseConnection;
    queries: QueryBuilder;
};
export declare function detectBackend(projectRoot?: string): DetectedBackend;
//# sourceMappingURL=loader.d.ts.map