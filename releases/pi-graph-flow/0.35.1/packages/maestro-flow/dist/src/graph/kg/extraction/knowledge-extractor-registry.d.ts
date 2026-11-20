import type { ExtractionResult, SourceType } from '../db/types.js';
export type ExtractorFunction = (sourcePath: string, workflowRoot: string) => ExtractionResult;
export type PathResolver = (workflowRoot: string) => string;
export interface KnowledgeExtractorEntry {
    name: string;
    sourceType: SourceType;
    extractFn: ExtractorFunction;
    resolvePath: PathResolver;
}
declare class KnowledgeExtractorRegistryImpl {
    private registry;
    constructor();
    private registerDefaults;
    register(entry: KnowledgeExtractorEntry): void;
    unregister(name: string): boolean;
    get(name: string): KnowledgeExtractorEntry | undefined;
    getAll(): KnowledgeExtractorEntry[];
    has(name: string): boolean;
    get size(): number;
}
export declare const KnowledgeExtractorRegistry: KnowledgeExtractorRegistryImpl;
export type { KnowledgeExtractorRegistryImpl };
//# sourceMappingURL=knowledge-extractor-registry.d.ts.map