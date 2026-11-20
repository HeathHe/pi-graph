export interface SearchUsageRow {
    command: string;
    frequency: number;
    successRate: number;
    avgDuration: number;
    lastUsed: string;
    contexts: string[];
}
export declare const SEARCH_USAGE_COMMAND = "maestro-search";
export declare const SEARCH_USAGE_FILE = "maestro-search.jsonl";
/**
 * 记录一次 Maestro Search 使用（有结果曝光时调用）。
 *
 * - 已有 maestro-search 行：frequency+1，successRate/avgDuration 滚动平均，lastUsed 刷新
 * - 无行：追加新行（frequency=1）
 * - 同目录其它文件（patterns.jsonl 等）原样保留
 */
export declare function recordSearchUsage(projectRoot: string, options?: {
    success?: boolean;
    durationMs?: number;
    contexts?: string[];
}): void;
//# sourceMappingURL=search-usage.d.ts.map