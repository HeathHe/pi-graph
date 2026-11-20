import { type BuiltSearchAdapterReport } from '#built-search-adapter-contract';
export type BuiltProviderName = 'wiki' | 'kg' | 'code' | 'mixed' | 'linked';
export type { BuiltSearchAdapterExpected, BuiltSearchAdapterReport, CorpusEvidence, EvidenceEvent, EvidenceResult, EvidenceRun, WikiIndexSample, } from '#built-search-adapter-contract';
export interface BuiltSearchAdapterInput {
    workspaceRoot: string;
    corpusPath: string;
    qrelsPath: string;
    baselinePath: string;
    holdoutsPath: string;
    faultProvider?: BuiltProviderName;
}
interface ObservedWikiIndexSample {
    durationMs: number;
    cacheState: 'cold-build' | 'cache-hit';
}
export declare function assertColdWikiIndexEvidence(warmupSamples: readonly ObservedWikiIndexSample[], measuredSamples: readonly ObservedWikiIndexSample[]): void;
export declare function runBuiltSearchAdapter(input: BuiltSearchAdapterInput): Promise<BuiltSearchAdapterReport>;
//# sourceMappingURL=built-search-adapter.d.ts.map