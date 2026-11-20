import { KgDatabaseConnection, KgQueryBuilder } from './db/index.js';
import type { UnifiedNode, UnifiedEdge, UnifiedGraphStats, UnifiedSearchResult, SyncResult, ResolutionResult, ExtractionResult, SourceType } from './db/types.js';
import type { KnowledgeResolutionResult } from './resolution/knowledge-resolver.js';
import type { CodeStructuralResolutionResult } from './resolution/code-reference-resolver.js';
import type { HierarchyDirection, ImpactDirection, ImpactResult, TraversalResult, TypeHierarchyResult, NodeContext, NodeMetrics, PathSearchResult, PathStep } from './query/traversal.js';
import type { UnifiedSearchOutput } from './query/search.js';
import type { CodeEmbeddingIndex } from './embedding/code-embedding.js';
import type { BuiltContext } from './query/context-builder.js';
import type { KgSyncAttempt, KgSyncWatermark } from './sync-state.js';
export type NodeResolution = {
    status: 'resolved';
    query: string;
    strategy: 'id' | 'qualifiedName' | 'simpleName';
    node: UnifiedNode;
    candidates: UnifiedNode[];
} | {
    status: 'ambiguous' | 'not_found';
    query: string;
    strategy: 'qualifiedName' | 'simpleName' | 'none';
    candidates: UnifiedNode[];
};
export interface NodeResolutionErrorPayload {
    code: 'ambiguous_node' | 'node_not_found';
    query: string;
    strategy: 'qualifiedName' | 'simpleName' | 'none';
    candidates: string[];
}
export declare function makeNodeResolutionErrorPayload(resolution: Exclude<NodeResolution, {
    status: 'resolved';
}>): NodeResolutionErrorPayload;
export interface MaestroGraphHealth {
    status: 'pass' | 'warn' | 'fail';
    schemaVersion: number;
    errors: string[];
    integrity: {
        ok: boolean;
        messages: string[];
    };
    foreignKeys: {
        ok: boolean;
        violations: Array<Record<string, unknown>>;
    };
    syncState: {
        status: 'missing' | 'fresh' | 'stale' | 'error';
        stale: boolean;
        error: string | null;
        lastSuccessful: KgSyncWatermark | null;
    };
    lastAttempt: KgSyncAttempt | null;
    structuralRefs: {
        total: number;
        status: Record<string, number>;
        unresolved: number;
        unresolvedRatio: number;
        ambiguousRatio: number;
        notFoundRatio: number;
        invariants: {
            invalidResolved: number;
            resolvedWithoutTarget: number;
            resolvedWithoutOriginEdge: number;
            invalidOriginEdge: number;
        };
    };
}
export declare class MaestroGraph {
    private conn;
    private queries;
    private projectRoot;
    private _codeEmbeddingCache;
    constructor(projectRoot: string);
    static init(projectRoot: string): Promise<MaestroGraph>;
    static open(projectRoot: string): Promise<MaestroGraph>;
    /**
     * 以隔离只读方式打开现有 canonical MaestroGraph 数据库。
     * 此路径显式跳过 migration、sync 与 embedding lifecycle。
     */
    static openReadOnly(projectRoot: string): Promise<MaestroGraph>;
    static isInitialized(projectRoot: string): boolean;
    static openSync(projectRoot: string): MaestroGraph | null;
    get rawDb(): import('node:sqlite').DatabaseSync;
    close(): void;
    indexAll(options?: {
        sources?: SourceType[];
    }): Promise<SyncResult[]>;
    indexKnowledge(options?: {
        sources?: SourceType[];
    }): Promise<SyncResult[]>;
    sync(): Promise<SyncResult[]>;
    resolveReferences(): ResolutionResult;
    resolveCodeStructuralReferences(): CodeStructuralResolutionResult;
    resolveKnowledgeEdges(): KnowledgeResolutionResult;
    searchUnified(query: string, options?: {
        sourceTypes?: SourceType[];
        kinds?: string[];
        limit?: number;
        includeCode?: boolean;
        includeKnowledge?: boolean;
    }): UnifiedSearchOutput;
    searchCode(query: string, options?: {
        kinds?: string[];
        languages?: string[];
        limit?: number;
    }): UnifiedNode[];
    searchKnowledge(query: string, options?: {
        sourceTypes?: SourceType[];
        limit?: number;
    }): UnifiedNode[];
    private _getCodeEmbeddingDir;
    /**
     * Build (or incrementally rebuild) the code embedding index from all codegraph nodes.
     * Persists the index to .workflow/kg/code-embedding-index.bin and caches in memory.
     */
    buildCodeEmbeddings(): Promise<CodeEmbeddingIndex>;
    /**
     * Load the code embedding index from disk or return the in-memory cache.
     * Returns null if no persisted index exists.
     */
    getCodeEmbeddingIndex(): Promise<CodeEmbeddingIndex | null>;
    searchHybrid(query: string, options?: {
        limit?: number;
        sourceTypes?: SourceType[];
    }): Promise<UnifiedSearchResult[]>;
    private _getVectorResults;
    getNode(id: string): UnifiedNode | null;
    /** Resolve only exact identities; ambiguity is data, never a ranking decision. */
    resolveNode(query: string): NodeResolution;
    getStats(): UnifiedGraphStats;
    getHealth(): MaestroGraphHealth;
    getDetectedFrameworks(): string[];
    getCallers(nodeId: string, depth?: number): Array<{
        node: UnifiedNode;
        edge: UnifiedEdge;
    }>;
    getCallees(nodeId: string, depth?: number): Array<{
        node: UnifiedNode;
        edge: UnifiedEdge;
    }>;
    getImpact(nodeId: string, depth?: number, direction?: ImpactDirection): ImpactResult;
    traverse(startId: string, options?: {
        maxDepth?: number;
        edgeKinds?: string[];
        direction?: 'outgoing' | 'incoming' | 'both';
    }): TraversalResult;
    traverseDFS(startId: string, options?: {
        maxDepth?: number;
        edgeKinds?: string[];
        direction?: 'outgoing' | 'incoming' | 'both';
    }): TraversalResult;
    getTypeHierarchy(nodeId: string, options?: {
        direction?: HierarchyDirection;
        depth?: number;
        maxNodes?: number;
    }): TypeHierarchyResult;
    findUsages(nodeId: string): Array<{
        node: UnifiedNode;
        edge: UnifiedEdge;
    }>;
    getAncestors(nodeId: string): UnifiedNode[];
    getChildren(nodeId: string): UnifiedNode[];
    getCallGraph(nodeId: string, depth?: number): TraversalResult;
    getNodeContext(nodeId: string): NodeContext | null;
    getFileDependencies(filePath: string): string[];
    getFileDependents(filePath: string): string[];
    findDeadCode(options?: {
        kinds?: string[];
    }): UnifiedNode[];
    getNodeMetrics(nodeId: string): NodeMetrics | null;
    findShortestPath(fromId: string, toId: string, maxDepth?: number): PathStep[] | null;
    findShortestPathResult(fromId: string, toId: string, maxDepth?: number, maxNodes?: number): PathSearchResult;
    buildContext(query: string, options?: {
        expandDepth?: number;
        agentType?: string;
    }): BuiltContext;
    getQueryBuilder(): KgQueryBuilder;
    getConnection(): KgDatabaseConnection;
    insertExtractionResults(result: ExtractionResult): void;
}
//# sourceMappingURL=engine.d.ts.map