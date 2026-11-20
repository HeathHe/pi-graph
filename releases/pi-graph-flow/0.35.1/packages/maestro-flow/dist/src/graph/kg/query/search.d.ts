import type { KgQueryBuilder } from '../db/queries.js';
import type { UnifiedNode, UnifiedSearchResult, SourceType } from '../db/types.js';
import type { VectorSearchResult } from '../embedding/code-embedding.js';
import { type CandidateScoreMetadata } from './scoring.js';
export interface SearchOptions {
    /** 限定来源类型 */
    sourceTypes?: SourceType[];
    /** 限定节点类型 */
    kinds?: string[];
    /** 限定语言 */
    languages?: string[];
    /** 最大结果数 */
    limit?: number;
    /** 是否包含代码节点 */
    includeCode?: boolean;
    /** 是否包含知识节点 */
    includeKnowledge?: boolean;
    /** 图遍历深度 (从命中节点扩展) */
    expandDepth?: number;
}
export interface UnifiedSearchOutput {
    directMatches: UnifiedSearchResult[];
    summary: {
        codeSymbols: number;
        domainTerms: number;
        specRules: number;
        knowhowDocs: number;
        total: number;
    };
}
type SearchCandidateNode = UnifiedNode & CandidateScoreMetadata;
export declare function scoreCandidate(node: SearchCandidateNode, query: string): number;
/**
 * 统一搜索 — 跨代码 + 知识层查询
 *
 * 策略链: FTS5 → LIKE → Fuzzy
 * 多信号评分: BM25 + kindBonus + pathRelevance + nameMatchBonus
 * CJK 短查询降级到 LIKE (trigram 最小 3 字符)
 */
export declare function searchUnified(queries: KgQueryBuilder, query: string, options?: SearchOptions): UnifiedSearchOutput;
export declare function searchCodeOnly(queries: KgQueryBuilder, query: string, options?: {
    kinds?: string[];
    languages?: string[];
    limit?: number;
}): UnifiedNode[];
export declare function searchKnowledgeOnly(queries: KgQueryBuilder, query: string, options?: {
    sourceTypes?: SourceType[];
    limit?: number;
}): UnifiedNode[];
export interface ParsedQuery {
    text: string;
    kinds: string[];
    languages: string[];
    pathFilters: string[];
    sourceTypes: string[];
}
/**
 * 解析 field-qualified 查询
 * 例: "kind:function TenantService" → { text: "TenantService", kinds: ["function"] }
 * 支持: kind: lang: path: source:
 */
export declare function parseQuery(query: string): ParsedQuery;
/**
 * Merge FTS5 search results with vector search results using RRF (Reciprocal Rank Fusion).
 * Imports mergeHybrid from the wiki embedding module and maps between UnifiedSearchResult
 * and RankedResult formats.
 */
export declare function mergeCodeSearchResults(ftsResults: UnifiedSearchResult[], vecResults: VectorSearchResult[], queries: KgQueryBuilder, limit: number): UnifiedSearchResult[];
export {};
//# sourceMappingURL=search.d.ts.map