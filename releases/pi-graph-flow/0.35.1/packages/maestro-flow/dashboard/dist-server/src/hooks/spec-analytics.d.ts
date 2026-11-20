/**
 * Spec Analytics — Injection logging and statistics
 *
 * Records every spec injection call (spec-injector, keyword-spec-injector,
 * spec-injection-plugin) and CLI endpoint usage. Provides aggregated
 * statistics for improvement analysis.
 *
 * Design:
 * - Reuses jsonl-log.ts (appendLine, readAll, tailLast, rotateIfLarge)
 * - Synchronous, never throws — safe for hot-path hooks
 * - Config cached with 30s TTL to avoid repeated file reads
 * - Auto-rotation at configurable max file size
 */
import type { SpecAnalyticsConfig } from '../types/index.js';
export type InjectionSource = 'spec-injector' | 'keyword-spec-injector' | 'spec-injection-plugin';
export interface SpecInjectionLogEntry {
    id: string;
    timestamp: string;
    source: InjectionSource;
    agentType?: string;
    promptSnippet?: string;
    categories: string[];
    specCount: number;
    budgetAction?: string;
    contentLength: number;
    inject: boolean;
    reason?: string;
    matchedKeywords?: string[];
    matchedEntryIds?: string[];
    matchedEntries?: number;
    totalPromptKeywords?: number;
    dedupFilteredCount?: number;
    searchSource?: 'daemon' | 'indexer' | 'keyword' | 'none';
    domainTermsMatched?: number;
    inferredCategory?: string;
}
export interface CliEndpointLogEntry {
    id: string;
    timestamp: string;
    command: string;
    args: Record<string, unknown>;
}
export interface HookInvocationLogEntry {
    id: string;
    timestamp: string;
    hookName: string;
    pluginName?: string;
    nodeId?: string;
    durationMs?: number;
    outcome?: string;
    data?: Record<string, unknown>;
}
export type AnalyticsLogEntry = ({
    type: 'injection';
} & SpecInjectionLogEntry) | ({
    type: 'cli';
} & CliEndpointLogEntry) | ({
    type: 'hook';
} & HookInvocationLogEntry);
export interface SpecAnalyticsSummary {
    totalInjections: number;
    successfulInjections: number;
    failedInjections: number;
    hitRate: number;
    bySource: Record<string, {
        total: number;
        injected: number;
    }>;
    byAgentType: Record<string, {
        total: number;
        injected: number;
    }>;
    byCategory: Record<string, number>;
    byBudgetAction: Record<string, number>;
    keywordStats: {
        totalMatches: number;
        topKeywords: Array<{
            keyword: string;
            count: number;
        }>;
        avgMatchedPerPrompt: number;
        dedupFilteredTotal: number;
    };
    cliStats: Record<string, number>;
    hookStats: {
        totalInvocations: number;
        byHook: Record<string, number>;
        byPlugin: Record<string, number>;
        avgDurationMs: number;
    };
    timeRange: {
        earliest: string;
        latest: string;
    };
    totalEntries: number;
    logFileSize: number;
}
/**
 * Log a spec injection event. Synchronous, never throws.
 */
export declare function logInjectionEvent(projectPath: string, entry: Omit<SpecInjectionLogEntry, 'id' | 'timestamp'>, config?: SpecAnalyticsConfig): void;
/**
 * Log a CLI endpoint call. Synchronous, never throws.
 */
export declare function logCliEndpoint(projectPath: string, command: string, args: Record<string, unknown>, config?: SpecAnalyticsConfig): void;
/**
 * Log a workflow hook invocation. Synchronous, never throws.
 */
export declare function logHookInvocation(projectPath: string, entry: Omit<HookInvocationLogEntry, 'id' | 'timestamp'>, config?: SpecAnalyticsConfig): void;
/**
 * Read all analytics entries.
 */
export declare function readAnalytics(projectPath: string, config?: SpecAnalyticsConfig): AnalyticsLogEntry[];
/**
 * Read last N analytics entries (efficient tail).
 */
export declare function readRecentAnalytics(projectPath: string, n: number, config?: SpecAnalyticsConfig): AnalyticsLogEntry[];
/**
 * Get log file size in bytes. Returns 0 if file doesn't exist.
 */
export declare function getLogFileSize(projectPath: string, config?: SpecAnalyticsConfig): number;
/**
 * Clear analytics log by rotating it to archive.
 */
export declare function clearAnalyticsLog(projectPath: string, config?: SpecAnalyticsConfig): string | null;
/**
 * Compute aggregated statistics from log entries. Pure function, no IO.
 */
export declare function computeStats(entries: AnalyticsLogEntry[], logFileSize?: number): SpecAnalyticsSummary;
