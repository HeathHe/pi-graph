import type { UnifiedNodeKind } from '../db/types.js';
export declare function removeStopWords(tokens: string[]): string[];
export declare function getStemVariants(term: string): string[];
export declare function extractSearchTerms(query: string): string[];
/**
 * 代码查询扩展 — 基于 extractSearchTerms 分词 + 缩写同义词 + 词干变体
 * 返回包含原始 term、同义词和词干变体的扩展查询字符串
 */
export declare function expandCodeQuery(query: string): string;
export declare function kindBonus(kind: UnifiedNodeKind): number;
export declare function scorePathRelevance(filePath: string, query: string): number;
export declare function nameMatchBonus(name: string, query: string): number;
export interface ScoredResult {
    id: string;
    score: number;
}
export interface CandidateScoreMetadata {
    /** FTS retrieval signal 已转换为正向相关度。 */
    _bm25Score?: number;
    /** LIKE fallback 已计算完成的最终综合分。 */
    _computedScore?: number;
}
export type ScoreCandidateNode = {
    id: string;
    kind: UnifiedNodeKind;
    name: string;
    filePath: string;
} & CandidateScoreMetadata;
/**
 * How strongly a match on a symbol of this kind corroborates that its FILE is
 * what the query is about.
 *   1.0   a callable or a type — the unit an architecture question is about
 *   ~0.5  a member of a type, or the file node (a path match, not a symbol)
 *   ~0.3  a variable / constant — as often a name collision as a definition
 *   0.15  a parameter — essentially never the subject of a question
 * Unlisted kinds fall back to DEFAULT so a new NodeKind is neither free nor fatal.
 */
export declare const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>>;
/** Kinds whose evidentiary value depends on whether anything USES them. */
export declare const WEAK_RELEVANCE_KINDS: ReadonlySet<string>;
/** Weight for a weak-kind symbol with no incoming/outgoing usage edge at all. */
export declare const ISOLATED_WEAK_KIND_WEIGHT = 0.08;
/**
 * Edges that mean "this symbol is used". `contains` is lexical nesting, not
 * usage — counting it would make every file-scope constant look corroborated,
 * which is exactly the case this guards against.
 */
export declare const RELEVANCE_USAGE_EDGES: ReadonlySet<string>;
/**
 * Cap on what PERIPHERAL nodes (in the subgraph, but neither a query match nor
 * adjacent to one) can contribute to a file's score. Uncapped, each such node
 * added a flat +1, so a file grew more "relevant" simply by being bigger — size
 * is not evidence; cap its contribution. Applied at the file-group level in the
 * ranking pass (context-builder), exposed here for that pass to import.
 */
export declare const PERIPHERAL_SCORE_CAP = 5;
/** Rank penalties, applied to BOTH the relevance score and the graph mass. */
export declare const GENERATED_RANK_PENALTY = 0.3;
export declare const LOW_VALUE_RANK_PENALTY = 0.5;
/** Ambient declaration files — hand-written `.d.ts` of global shims (CG-28). */
export declare const AMBIENT_DECLARATION_RANK_PENALTY = 0.5;
/**
 * Opt-in relevance context for {@link computeScore}. When absent, computeScore
 * keeps its exact legacy (additive) behaviour. When present, the multiplicative
 * CG-10 demotions apply: kind weight scales the symbol-match signal, isolation
 * zeroes an unused weak-kind match, and rankPenalty demotes generated/test/
 * ambient-declaration files on the PRIMARY sort key.
 */
export interface RelevanceContext {
    /**
     * Return true if `nodeId` has no incoming/outgoing usage edge (see
     * {@link RELEVANCE_USAGE_EDGES}). Used by the isolation lever. If absent, no
     * isolation probing — weak kinds keep their base weight (fail-open).
     */
    isUsageIsolated?: (nodeId: string) => boolean;
    /**
     * Per-file classification flags for the rank penalty. If absent, no rank
     * penalty applies (fail-open).
     */
    classifyFile?: (filePath: string) => {
        isGenerated?: boolean;
        isLowValue?: boolean;
        isDampedDeclaration?: boolean;
    };
}
/**
 * Multiplicative kind weight. When `probeIsolation` is true and the kind is
 * weak, an isolated symbol (nothing uses it) drops to
 * {@link ISOLATED_WEAK_KIND_WEIGHT}. Mirrors codegraph's `relevanceWeight`.
 */
export declare function relevanceWeight(kind: UnifiedNodeKind, opts?: {
    probeIsolation?: boolean;
    nodeId?: string;
    isUsageIsolated?: (nodeId: string) => boolean;
}): number;
/**
 * File-level rank penalty (CG-10 lever 3). Applied multiplicatively to BOTH the
 * score and graph mass in the ranking pass. Generated and ambient-declaration
 * are taken as `min` (stronger) — penalising twice for the same property is how
 * a file gets cliffed out of answers where it is genuinely relevant. The
 * low-value multiplier compounds (a generated test file is two reasons).
 */
export declare function rankPenalty(filePath: string, classify: NonNullable<RelevanceContext['classifyFile']>): number;
export declare function computeScore(node: ScoreCandidateNode, query: string, credibilityFactor?: number, opts?: {
    relevanceContext?: RelevanceContext;
}): number;
export declare function compareNodeTie(left: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>, right: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>): number;
export declare function compareScoredNodes(left: {
    node: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>;
    score: number;
}, right: {
    node: Pick<ScoreCandidateNode, 'kind' | 'name' | 'id'>;
    score: number;
}): number;
//# sourceMappingURL=scoring.d.ts.map