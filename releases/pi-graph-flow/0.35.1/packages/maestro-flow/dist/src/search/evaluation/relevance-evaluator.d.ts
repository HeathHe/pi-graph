import { SEARCH_MEASUREMENT_LANES, type SearchMeasurementLane } from '#built-search-adapter-contract';
export { SEARCH_MEASUREMENT_LANES };
export type { SearchMeasurementLane };
export declare const LATENCY_WARMUPS = 20;
export declare const LATENCY_SAMPLES = 100;
export declare const DEFAULT_QUALITY_RUNS = 5;
export declare const DEFAULT_TOP_K = 20;
/**
 * The benchmark lanes are generated from the adapter contract so evaluator
 * and release-machine validation cannot drift. Callers still provide each
 * evaluation-only operation; the contract does not alter production paths.
 */
export type SearchMeasurementPhase = 'cold' | 'warm' | 'update' | 'freshness';
export interface SearchMeasurementStats {
    warmups: number;
    measuredSamples: number;
    samplesMs: number[];
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
}
export interface SearchMeasurementLaneReport {
    lane: SearchMeasurementLane;
    phase: SearchMeasurementPhase;
    status: 'measured' | 'deferred';
    stats: SearchMeasurementStats | null;
    reason?: string;
}
export interface SearchMeasurementReport {
    schema_version: 'search-ranking-measurements/1.0';
    lanes: SearchMeasurementLaneReport[];
    complete: boolean;
}
export type SearchMeasurementOperation = () => void | Promise<void>;
export interface SearchMeasurementOptions {
    warmups?: number;
    measuredSamples?: number;
}
export type SearchMeasurementOperations = Partial<Record<SearchMeasurementLane, SearchMeasurementOperation>>;
export type RankingCategory = 'exact-symbol' | 'wiki-short' | 'knowledge' | 'mixed' | 'linked-scope' | string;
export interface RankingDocument {
    id: string;
    kind: string;
    title: string;
    summary: string;
    tags: string[];
    body: string;
    status?: string;
    workspace?: string;
    authorized?: boolean;
    provenance?: {
        source: string;
        path: string;
    };
}
export interface RankingCorpusManifest {
    schema_version: 'search-ranking-corpus-manifest/1.0';
    expandedDocumentCount: number;
    expandedSha256: string;
    wikiSourceDocumentCount: number;
    measurementLanes: SearchMeasurementLane[];
}
export interface RankingCorpusFixture {
    schema_version: 'search-ranking-corpus/1.0';
    documents: RankingDocument[];
    latencyCorpus: {
        size: number;
        idPrefix: string;
        vocabulary: string[];
    };
    manifest: RankingCorpusManifest;
    absoluteQueries?: Array<{
        id: string;
        query: string;
    }>;
}
export interface RankingJudgment {
    id: string;
    query: string;
    category: RankingCategory;
    relevance: Record<string, number>;
}
export interface RankingQrelsFixture {
    schema_version: 'search-ranking-qrels/1.0';
    queries: RankingJudgment[];
}
export interface RankingHoldout {
    id: string;
    query: string;
    targetIds: string[];
    category: string;
}
export interface RankingHoldoutsFixture {
    schema_version: 'search-ranking-holdouts/1.0';
    queries: RankingHoldout[];
}
export interface RankingMetrics {
    ndcgAt10: number;
    mrrAt10: number;
    recallAt20: number;
}
export interface RankingBaselineFixture {
    schema_version: 'search-ranking-baseline/1.0';
    qrelsSha256: string;
    sourceRevision: string;
    knownOrder: Record<string, string[]>;
    metrics: {
        overall: RankingMetrics;
        categories: Record<string, RankingMetrics>;
    };
    protocol: {
        qualityRuns: number;
        topK: number;
        warmups: number;
        measuredSamples: number;
        corpusSize: number;
        wikiSourceDocumentCount: number;
        expandedSha256: string;
    };
}
export interface RankedDocument {
    id: string;
    score: number;
}
export type RankingProvider = (query: string, documents: readonly RankingDocument[], limit: number) => readonly RankedDocument[] | Promise<readonly RankedDocument[]>;
export interface QueryStability {
    queryId: string;
    top20Runs: string[][];
    stable: boolean;
}
export interface QuerySpecialCaseHit {
    path: string;
    line: number;
    kind: 'query-literal' | 'pi-branch';
    match: string;
}
export interface QuerySpecialCaseScan {
    querySpecialCaseHits: number;
    hits: QuerySpecialCaseHit[];
    scannedFiles: number;
}
export interface SearchRankingReport {
    schema_version: 'search-ranking-report/1.0';
    ok: true;
    qrelsSha256: string;
    qrelsSha256Match: true;
    metrics: {
        overall: RankingMetrics;
        categories: Record<string, RankingMetrics>;
    };
    overallNdcgGain: number;
    maxCategoryNdcgDrop: number;
    categoryNdcgDeltas: Record<string, number>;
    qualityGate: {
        minOverallNdcgGain: 0.1;
        maxCategoryNdcgDrop: 0.02;
        pass: true;
    };
    stability: {
        runs: number;
        topK: number;
        stableTop20: boolean;
        queries: QueryStability[];
    };
    latency: {
        warmups: 20;
        measuredSamples: 100;
        p50Ms: number;
        p95Ms: number;
        maxMs: number;
        corpusSize: number;
        runner: {
            node: string;
            platform: NodeJS.Platform;
            arch: string;
            cpuCount: number;
        };
    };
    scanner: QuerySpecialCaseScan;
    integrity: {
        deprecatedLeakCount: number;
        unauthorizedWorkspaceHitCount: number;
        provenanceLossCount: number;
        holdoutOverlapCount: 0;
    };
    workspace: {
        root: string;
        wikiFixturePath: string;
        maestroGraphPath: string;
    };
}
export interface EvaluateRankingInput {
    workspaceRoot: string;
    corpusPath: string;
    qrelsPath: string;
    baselinePath: string;
    holdoutsPath: string;
    runs?: number;
    topK?: number;
    ranker?: RankingProvider;
    productionPaths?: string[];
    excludeGlobs?: string[];
}
export interface QuerySpecialCaseInput {
    queryFiles: string[];
    productionPaths: string[];
    excludeGlobs?: string[];
}
interface MachineFailure {
    schema_version: 'search-ranking-failure/1.0';
    ok: false;
    code: string;
    message: string;
    details?: unknown;
}
export declare class RankingEvaluationError extends Error {
    readonly failure: MachineFailure;
    constructor(code: string, message: string, details?: unknown);
    toJSON(): MachineFailure;
}
export declare function loadRankingFixture<T>(path: string): Promise<T>;
export declare function sha256File(path: string): Promise<string>;
/** Hashes the expanded, generated corpus rather than the self-referential fixture manifest. */
export declare function expandedCorpusSha256(corpus: RankingCorpusFixture): string;
export declare function wikiSourceDocuments(corpus: RankingCorpusFixture): RankingDocument[];
export interface WikiCorpusIndexEntry {
    id?: unknown;
    source?: {
        kind?: unknown;
        path?: unknown;
    };
    sourceRef?: unknown;
}
export interface WikiCorpusIndexEvidence {
    expectedEntryCount: number;
    indexedEntryCount: number;
    missingSourceRefs: string[];
    duplicateSourceRefs: string[];
}
/**
 * Count only file-backed corpus entries.  KG virtual projections are
 * intentionally excluded: they are a separate provider and must not make a
 * Wiki corpus appear indexed when its source files were never scanned.
 */
export declare function inspectWikiCorpusIndex(entries: readonly WikiCorpusIndexEntry[], corpus: RankingCorpusFixture): WikiCorpusIndexEvidence;
export declare function assertWikiCorpusIndex(entries: readonly WikiCorpusIndexEntry[], corpus: RankingCorpusFixture): WikiCorpusIndexEvidence;
export declare function measureSearchLane(lane: SearchMeasurementLane, operation: SearchMeasurementOperation, options?: SearchMeasurementOptions & {
    phase?: SearchMeasurementPhase;
}): Promise<SearchMeasurementLaneReport>;
export declare function measureSearchLanes(operations: SearchMeasurementOperations, options?: SearchMeasurementOptions): Promise<SearchMeasurementReport>;
export declare function assertCompleteSearchMeasurements(report: SearchMeasurementReport): void;
export declare function validateSearchMeasurementReport(report: SearchMeasurementReport, requireComplete?: boolean): void;
export declare function validateCorpus(value: RankingCorpusFixture): void;
export declare function validateQrels(value: RankingQrelsFixture, documentIds: Set<string>): void;
export declare function validateBaseline(value: RankingBaselineFixture): void;
export declare function validateHoldouts(value: RankingHoldoutsFixture): void;
export declare function assertQrelsHash(qrelsSha256: string, baseline: RankingBaselineFixture): void;
export declare function validateRankingFixtures(corpus: RankingCorpusFixture, qrels: RankingQrelsFixture, baseline: RankingBaselineFixture, holdouts: RankingHoldoutsFixture): void;
export declare function assertHoldoutsDisjoint(holdouts: RankingHoldoutsFixture, qrels: RankingQrelsFixture, corpus: RankingCorpusFixture): void;
export declare function expandCorpus(corpus: RankingCorpusFixture): RankingDocument[];
export interface HermeticSearchWorkspace {
    root: string;
    wikiFixturePath: string;
    maestroGraphPath: string;
    linkedWorkspaceRoot: string;
    linkedMaestroGraphPath: string;
    unauthorizedWorkspaceRoot: string;
    unauthorizedMaestroGraphPath: string;
    corpusSize: number;
    wikiSourceDocumentCount: number;
    expandedCorpusSha256: string;
}
export declare function buildHermeticSearchWorkspace(corpus: RankingCorpusFixture, root: string): Promise<HermeticSearchWorkspace>;
export declare const lexicalFixtureRanker: RankingProvider;
export declare function normalizeRanking(ranking: readonly RankedDocument[], limit: number): RankedDocument[];
export declare function computeRankingMetrics(rankedIds: readonly string[], relevance: Readonly<Record<string, number>>): RankingMetrics;
export interface AggregatedRankingMetrics {
    overall: RankingMetrics;
    categories: Record<string, RankingMetrics>;
}
export declare function aggregateRankingMetrics(values: readonly {
    category: string;
    metrics: RankingMetrics;
}[]): AggregatedRankingMetrics;
export declare function computeKnownOrderBaselineMetrics(qrels: RankingQrelsFixture, knownOrder: Readonly<Record<string, readonly string[]>>): AggregatedRankingMetrics;
export declare function assertStableTopK(runs: readonly (readonly string[])[], queryId?: string): void;
export declare function scanQuerySpecialCases(input: QuerySpecialCaseInput): Promise<QuerySpecialCaseScan>;
export declare function assertNoQuerySpecialCases(input: QuerySpecialCaseInput): Promise<QuerySpecialCaseScan>;
export interface RankingBaselineComparison {
    ok: boolean;
    overall: RankingMetrics;
    categories: Record<string, RankingMetrics>;
    overallNdcgGain: number;
    maxCategoryNdcgDrop: number;
    categoryNdcgDeltas: Record<string, number>;
    thresholds: {
        minOverallNdcgGain: number;
        maxCategoryNdcgDrop: number;
    };
}
export declare function compareRankingBaseline(report: Pick<SearchRankingReport, 'qrelsSha256' | 'metrics'>, baseline: RankingBaselineFixture, options?: {
    minOverallNdcgGain?: number;
    maxCategoryNdcgDrop?: number;
}): RankingBaselineComparison;
export declare function evaluateRanking(input: EvaluateRankingInput): Promise<SearchRankingReport>;
//# sourceMappingURL=relevance-evaluator.d.ts.map