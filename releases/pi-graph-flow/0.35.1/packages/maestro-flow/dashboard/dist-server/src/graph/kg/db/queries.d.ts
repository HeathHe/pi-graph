import type { KgDatabaseConnection } from './connection.js';
import type { UnifiedNode, UnifiedEdge, FileRecord, UnifiedNodeKind, UnifiedEdgeKind, SourceType, UnifiedGraphStats } from './types.js';
import { type CandidateScoreMetadata } from '../query/scoring.js';
import { type StoredStructuralReference, type StructuralReference, type StructuralReferenceResolution, type StructuralReferenceStatus } from '../resolution/structural-reference.js';
export interface StructuralReferenceFilter {
    refKeys?: string[];
    originFilePaths?: string[];
    statuses?: StructuralReferenceStatus[];
}
export interface StructuralReferenceInvariantCounts {
    invalidResolved: number;
    resolvedWithoutTarget: number;
    resolvedWithoutOriginEdge: number;
    invalidOriginEdge: number;
}
interface FileRow {
    path: string;
    content_hash: string | null;
    language: string | null;
    size: number | null;
    modified_at: number | null;
    indexed_at: number | null;
    node_count: number;
    errors: string | null;
    source_type: string | null;
}
export declare class KgQueryBuilder {
    private conn;
    constructor(conn: KgDatabaseConnection);
    private get db();
    insertNode(node: UnifiedNode): void;
    insertNodes(nodes: UnifiedNode[]): number;
    getNode(id: string): UnifiedNode | null;
    getNodesByQualifiedName(qualifiedName: string): UnifiedNode[];
    getNodesByName(name: string): UnifiedNode[];
    getNodesByIds(ids: string[]): Map<string, UnifiedNode>;
    getNodesByKind(kinds: UnifiedNodeKind[]): UnifiedNode[];
    getNodesByFile(filePath: string): UnifiedNode[];
    getNodesBySourceType(sourceType: SourceType): UnifiedNode[];
    deleteNode(id: string): void;
    deleteNodesBySourceTypeAndFile(sourceType: SourceType, filePath: string): number;
    deleteNodesBySourceType(sourceType: SourceType): number;
    insertEdge(edge: UnifiedEdge): void;
    private writeEdgeRow;
    insertEdges(edges: UnifiedEdge[]): number;
    upsertStructuralEdge(edge: UnifiedEdge & {
        originRefKey: string;
    }): void;
    getOutgoingEdges(nodeId: string, kind?: UnifiedEdgeKind): UnifiedEdge[];
    getIncomingEdges(nodeId: string, kind?: UnifiedEdgeKind): UnifiedEdge[];
    getOutgoingEdgesBatch(nodeIds: string[]): Map<string, UnifiedEdge[]>;
    getIncomingEdgesBatch(nodeIds: string[]): Map<string, UnifiedEdge[]>;
    deleteEdgesByProvenanceAndSource(provenance: string, sourcePrefix: string): number;
    insertUnresolvedRef(ref: {
        fromNodeId: string;
        referenceName: string;
        referenceKind: string;
        line: number;
        col: number;
        filePath: string;
        language: string;
        candidates?: string[];
    }): void;
    getUnresolvedRefsByFile(filePath: string): Array<{
        id: number;
        fromNodeId: string;
        referenceName: string;
        referenceKind: string;
        line: number;
        col: number;
        filePath: string;
        language: string;
        candidates: string[];
    }>;
    deleteUnresolvedRefsByFile(filePath: string): number;
    /**
     * Stages replayable syntax facts. This method intentionally owns no
     * transaction; the codegraph replacement orchestrator is the transaction owner.
     */
    stageStructuralReferences(refs: StructuralReference[], now?: number): number;
    upsertStructuralReferences(refs: StructuralReference[], now?: number): number;
    getStructuralReference(refKey: string): StoredStructuralReference | null;
    listStructuralReferences(filter?: StructuralReferenceFilter): StoredStructuralReference[];
    updateStructuralReferenceResolution(refKey: string, resolution: StructuralReferenceResolution, now?: number): void;
    setStructuralReferenceResolution(refKey: string, resolution: StructuralReferenceResolution, now?: number): void;
    resetStructuralReferenceStatuses(filter?: StructuralReferenceFilter, now?: number): number;
    getStructuralReferenceStatusCounts(): Record<StructuralReferenceStatus, number>;
    countStructuralReferencesByStatus(): Record<StructuralReferenceStatus, number>;
    getStructuralReferenceInvariantCounts(): StructuralReferenceInvariantCounts;
    deleteStructuralReferencesByOriginFile(filePath: string): number;
    upsertFile(record: FileRecord): void;
    deleteFilesBySourceType(sourceType: SourceType): number;
    getFile(filePath: string): FileRecord | null;
    /** Includes zero-symbol files so scan-scoped Unicode collisions stay fail-closed. */
    getFilePathsBySourceType(sourceType: SourceType): string[];
    getStaleFiles(): FileRow[];
    /**
     * Reconciles the selective internal-storage FTS index inside the caller's
     * transaction. The FTS5 `delete-all` command is invalid for this table mode,
     * so use an ordinary DELETE before the filtered refill.
     */
    rebuildCodeFtsStrict(): number;
    getStats(dbSizeBytes: number): UnifiedGraphStats;
    searchCodeFTS(query: string, opts: {
        limit?: number;
        kinds?: string[];
        languages?: string[];
        pathFilters?: string[];
    }): Array<UnifiedNode & CandidateScoreMetadata>;
    private runCodeFtsQuery;
    private codeFtsRebuilt;
    private tryRebuildCodeFts;
    searchKnowledgeFTS(query: string, opts: {
        limit?: number;
        sourceTypes?: SourceType[];
    }): Array<UnifiedNode & CandidateScoreMetadata>;
    private runKnowledgeFtsQuery;
    private knowledgeFtsRebuilt;
    private tryRebuildKnowledgeFts;
    searchUnified(query: string, opts: {
        limit?: number;
        sourceTypes?: SourceType[];
    }): UnifiedNode[];
    private searchNodesLike;
    private searchKnowledgeLike;
}
export declare function sanitizeFtsQuery(input: string): string;
export {};
