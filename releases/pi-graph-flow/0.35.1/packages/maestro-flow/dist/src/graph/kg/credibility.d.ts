import type { DatabaseSync } from 'node:sqlite';
export interface CredibilityRow {
    node_id: string;
    content_hash: string;
    search_hits: number;
    consumption_count: number;
    last_hit_at: number | null;
    last_consumed_at: number | null;
    content_changed_at: number;
    created_at: number;
}
export interface CredibilityConfig {
    floor: number;
    warningThreshold: number;
    halfLives: Record<string, number>;
}
declare const DEFAULT_CONFIG: CredibilityConfig;
export declare const CREDIBILITY_MIGRATION_SQL = "\nCREATE TABLE IF NOT EXISTS credibility (\n    node_id             TEXT PRIMARY KEY,\n    content_hash        TEXT NOT NULL,\n    search_hits         INTEGER NOT NULL DEFAULT 0,\n    consumption_count   INTEGER NOT NULL DEFAULT 0,\n    last_hit_at         INTEGER,\n    last_consumed_at    INTEGER,\n    content_changed_at  INTEGER NOT NULL,\n    created_at          INTEGER NOT NULL\n);\n\nCREATE INDEX IF NOT EXISTS idx_credibility_search_hits ON credibility(search_hits);\nCREATE INDEX IF NOT EXISTS idx_credibility_content_changed ON credibility(content_changed_at);\n";
export declare function computeDecayFactor(ageDays: number, nodeType: string, config?: CredibilityConfig): number;
export declare function computeCredibilityFactor(row: CredibilityRow | null, nodeType: string, nowMs?: number, config?: CredibilityConfig): number;
export declare function isLowCredibility(factor: number, config?: CredibilityConfig): boolean;
export declare function contentHash(body: string): string;
export declare class CredibilityStore {
    private db;
    constructor(db: DatabaseSync);
    upsert(nodeId: string, hash: string, nowMs?: number): void;
    get(nodeId: string): CredibilityRow | null;
    getMany(nodeIds: string[]): Map<string, CredibilityRow>;
    getAll(): CredibilityRow[];
    incrementImpressions(nodeIds: string[], nowMs?: number): void;
    /**
     * Backward-compatible alias. `search_hits` is an exposure counter: a result
     * was returned or injected, not necessarily opened or used.
     */
    incrementSearchHits(nodeIds: string[], nowMs?: number): void;
    incrementConsumption(nodeId: string, nowMs?: number): void;
    incrementConsumptions(nodeIds: string[], nowMs?: number): void;
    cleanOrphans(): number;
}
export declare function wikiIdToNodeId(wikiId: string): string | null;
export { DEFAULT_CONFIG as CREDIBILITY_DEFAULT_CONFIG };
//# sourceMappingURL=credibility.d.ts.map