import type { KgQueryBuilder } from '../db/queries.js';
import type { SourceType } from '../db/types.js';
import { type ExploreOutputBudget } from './allocation.js';
export interface ContextSection {
    label: string;
    lines: string[];
    sourceType: SourceType;
    relevance: number;
}
export interface ContextBudget {
    maxTotalChars: number;
    maxSections: number;
    maxCharsPerSection: number;
}
export interface BuiltContext {
    sections: ContextSection[];
    totalChars: number;
    summary: {
        codeSymbols: number;
        domainTerms: number;
        specRules: number;
        knowhowDocs: number;
    };
}
/**
 * 从查询结果构建 agent 上下文
 *
 * 1. FTS5 搜索 → 直接命中
 * 2. 图遍历 → 1-hop 关联
 * 3. 按 source_type 分组组装 sections
 * 4. Context budget 管控
 */
export declare function buildContext(queries: KgQueryBuilder, prompt: string, options?: {
    budget?: Partial<ContextBudget>;
    expandDepth?: number;
    agentType?: string;
}): BuiltContext;
/**
 * Render ranked sections under an allocation-driven budget (exported for
 * unit testing). Sections are RESERVED a score-proportional share of the
 * envelope up front ({@link allocateExploreBudget}); the loop spends those
 * reservations — never a flat cap. Pure function: no DB, no I/O.
 *
 * Invariant: every admitted section receives >= its reservation before any
 * section draws carry-forward slack; cliffed sections are NAMED (a pointer,
 * never a bare omission); the whole response stays under the hard ceiling.
 */
export declare function renderSectionsWithBudget(sections: ContextSection[], tierBudget: ExploreOutputBudget): {
    sections: ContextSection[];
    totalChars: number;
};
export declare function getAgentCategories(agentType: string): string[];
//# sourceMappingURL=context-builder.d.ts.map