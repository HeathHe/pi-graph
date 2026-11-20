export interface MatchResult {
    qualifiedName: string;
    confidence: number;
    strategy: MatchStrategy;
    filePath?: string;
}
export type MatchStrategy = 'exact-name' | 'qualified-suffix' | 'file-path' | 'method-call' | 'fuzzy-tokens' | 'path-proximity';
/**
 * 名称匹配入口 — 按优先级依次尝试 6 种策略
 * 返回最匹配的结果, 或 null (无匹配)
 */
export declare function matchReference(referenceName: string, candidates: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    filePath: string;
}>, context?: {
    fromFilePath?: string;
    receiverType?: string;
}): MatchResult | null;
/**
 * 驼峰/蛇形/SCREAMING_SNAKE/dot 分词
 */
export declare function tokenize(identifier: string): string[];
//# sourceMappingURL=name-matcher.d.ts.map