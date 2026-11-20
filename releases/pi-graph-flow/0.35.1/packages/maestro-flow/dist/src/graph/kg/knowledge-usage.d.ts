import type { DatabaseSync } from 'node:sqlite';
export interface KnowledgeUsageRef {
    id: string;
    sourceRef?: string | null;
}
export interface KnowledgeConsumptionRecord {
    recorded: number;
    nodeIds: string[];
}
export interface KnowledgeUsageSignal {
    impressions: number;
    consumptions: number;
}
export interface KnowledgeUsageBySource {
    sourceType: string;
    nodes: number;
    tracked: number;
    impressionNodes: number;
    consumedNodes: number;
    impressions: number;
    consumptions: number;
}
export interface KnowledgeUsageConcentration {
    positiveNodes: number;
    totalEvents: number;
    top1Share: number;
    top5Share: number;
    top10Share: number;
    gini: number;
    hhi: number;
    effectiveNodes: number;
}
export interface KnowledgeUsageTopEntry {
    sourceType: string;
    id: string;
    name: string;
    impressions: number;
    consumptions: number;
    lastImpressionAt: number | null;
    lastConsumedAt: number | null;
}
export interface KnowledgeUsageStats {
    schemaVersion: 'knowledge-usage-stats/1.0';
    semantics: {
        impressions: 'returned-or-injected';
        consumptions: 'explicit-content-load';
        affectsRanking: false;
        impressionsMayFillExplorationSlot: true;
        consumptionsAffectRetrieval: false;
    };
    filter: {
        sourceType: string | null;
    };
    bySource: KnowledgeUsageBySource[];
    impressionConcentration: KnowledgeUsageConcentration;
    consumptionConcentration: KnowledgeUsageConcentration;
    topEntries: KnowledgeUsageTopEntry[];
}
/**
 * Record only explicit content loads. Listing and search result exposure must
 * not call this function.
 */
export declare function recordKnowledgeConsumptionsDetailed(projectRoot: string, refs: KnowledgeUsageRef[], nowMs?: number): KnowledgeConsumptionRecord;
export declare function recordKnowledgeConsumptions(projectRoot: string, refs: KnowledgeUsageRef[], nowMs?: number): number;
/**
 * Read exposure/use counters for retrieval diversification. Signals are keyed
 * by the caller's Wiki id and are never folded into the relevance score.
 */
export declare function readKnowledgeUsageSignals(projectRoot: string, refs: KnowledgeUsageRef[]): Map<string, KnowledgeUsageSignal>;
export declare function buildKnowledgeUsageStats(db: DatabaseSync, sourceType?: string | null, topLimit?: number): KnowledgeUsageStats;
//# sourceMappingURL=knowledge-usage.d.ts.map