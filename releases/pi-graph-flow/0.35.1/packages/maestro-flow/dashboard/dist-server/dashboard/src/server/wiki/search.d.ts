import type { WikiEntry } from './wiki-types.js';
import type { SearchCandidateBudget } from '../../../../src/search/candidate-budget.js';
interface WeightedTerm {
    term: string;
    weight: number;
    coverageKey?: string;
}
export interface CoverageTerm {
    key: string;
    terms: string[];
    weight: number;
}
export interface CoveragePenaltyOptions {
    coreTerms: readonly CoverageTerm[];
    baseFactor?: number;
}
export declare function applyCoveragePenalty(score: number, matchedCoreWeight: number, totalCoreWeight: number, baseFactor?: number): number;
export type QueryTermRole = 'anchor' | 'core' | 'context';
export interface QueryTokenClassification {
    raw: string;
    normalized: string;
    role: QueryTermRole;
    weight: number;
}
export interface QueryPlanGroup {
    role: QueryTermRole;
    weightedTerms: WeightedTerm[];
    rrfWeight: number;
}
export interface QueryPlan {
    rawQuery: string;
    tokens: QueryTokenClassification[];
    groups: QueryPlanGroup[];
    coreCoverageTerms: CoverageTerm[];
}
type FieldName = 'title' | 'summary' | 'tags' | 'body';
/** @deprecated Legacy flat posting — kept for test backward compat only. */
export interface Posting {
    docId: string;
    tf: number;
}
export type FieldConfigKey = 'default' | 'kg' | 'session';
export interface InvertedIndex {
    /** @deprecated Legacy flat postings — not used by BM25F scoring. */
    postings: Map<string, Posting[]>;
    /** @deprecated Legacy flat doc lengths — not used by BM25F scoring. */
    docLengths: Map<string, number>;
    /** @deprecated Legacy flat avg doc length — not used by BM25F scoring. */
    avgDocLength: number;
    totalDocs: number;
    fieldPostings: Map<string, FieldPosting[]>;
    fieldLengths: Map<string, FieldLengths>;
    avgFieldLengths: FieldLengths;
    docConfigKeys: Map<string, FieldConfigKey>;
}
export interface SearchResult {
    docId: string;
    score: number;
}
export type FieldLengths = Record<FieldName, number>;
interface FieldPosting {
    docId: string;
    fieldTfs: Record<FieldName, number>;
}
/** JSON-safe representation of the BM25F acceleration index. */
export interface SerializedInvertedIndex {
    /** Stable payload marker; entries remain the canonical source of truth. */
    schemaVersion: 'bm25f/1';
    /** Explicit payload version for forward-compatible validation. */
    version: 1;
    totalDocs: number;
    avgFieldLengths: FieldLengths;
    fieldPostings: Array<readonly [
        string,
        Array<{
            docId: string;
            fieldTfs: FieldLengths;
        }>
    ]>;
    fieldLengths: Array<readonly [string, FieldLengths]>;
    docConfigKeys: Array<readonly [string, FieldConfigKey]>;
    /** Optional publication metadata used to reject stale acceleration hints. */
    generation?: number;
    sourceFingerprint?: string;
    docIdFingerprint?: string;
    configFingerprint?: string;
}
export interface InvertedIndexSerializationMetadata {
    generation?: number;
    sourceFingerprint?: string;
}
export interface InvertedIndexValidationOptions {
    expectedGeneration?: number;
    expectedSourceFingerprint?: string;
    expectedDocIds?: ReadonlySet<string>;
    expectedDocConfigKeys?: ReadonlyMap<string, FieldConfigKey>;
}
/**
 * Serialize an in-memory BM25F index without Maps or prototype-bearing
 * objects. Arrays are used for deterministic output and compact JSON; term
 * and document IDs remain explicit so validation can reject duplicate keys.
 */
export declare function serializeInvertedIndex(index: InvertedIndex, metadata?: InvertedIndexSerializationMetadata): SerializedInvertedIndex;
/**
 * Validate and rehydrate a serialized BM25F index. Invalid acceleration data
 * returns null rather than throwing: callers must rebuild from WikiEntry[] so
 * a corrupt optional section can never hide canonical content.
 */
export declare function deserializeInvertedIndex(value: unknown, options?: InvertedIndexValidationOptions): InvertedIndex | null;
/** Explicit aliases for callers that refer to the compiled BM25F format. */
export declare const serializeBM25FIndex: typeof serializeInvertedIndex;
export declare const deserializeBM25FIndex: typeof deserializeInvertedIndex;
export declare function tokenize(text: string): string[];
/** Resolve the field-configuration identity without building postings. */
export declare function getInvertedIndexConfigKey(entry: WikiEntry): FieldConfigKey;
export declare function buildInvertedIndex(entries: WikiEntry[]): InvertedIndex;
export declare function searchBM25(index: InvertedIndex, query: string, limit?: number, credibilityFactors?: Map<string, number>, allowedDocIds?: ReadonlySet<string>, candidateBudget?: SearchCandidateBudget): SearchResult[];
export declare function buildQueryPlan(query: string, index?: InvertedIndex): QueryPlan;
export declare function searchBM25Planned(index: InvertedIndex, query: string, limit?: number, credibilityFactors?: Map<string, number>, allowedDocIds?: ReadonlySet<string>, candidateBudget?: SearchCandidateBudget): SearchResult[];
export interface ProximityRerankOptions {
    windowSize?: number;
    maxBoost?: number;
}
export declare function rerankByPhraseProximity(results: Array<{
    entry: WikiEntry;
    score: number;
}>, query: string, options?: ProximityRerankOptions): Array<{
    entry: WikiEntry;
    score: number;
}>;
export {};
