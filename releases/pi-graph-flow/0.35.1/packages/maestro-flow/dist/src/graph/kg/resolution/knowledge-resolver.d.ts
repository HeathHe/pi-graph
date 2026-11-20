import type { DatabaseSync } from 'node:sqlite';
import type { UnifiedEdge } from '../db/types.js';
export interface KnowledgeResolutionResult {
    edges: UnifiedEdge[];
    definesEdges: number;
    constrainsEdges: number;
    documentsEdges: number;
    derivedFromEdges: number;
    relatesToEdges: number;
    totalEdgesCreated: number;
    durationMs: number;
}
export declare function resolveKnowledgeEdges(db: DatabaseSync, options?: {
    projectPath?: string;
}): KnowledgeResolutionResult;
export interface RelatedNode {
    nodeId: string;
    depth: number;
    edgeKind: string;
}
export declare function expandRelated(db: DatabaseSync, seedNodeIds: string[], opts: {
    maxDepth?: number;
}): RelatedNode[];
//# sourceMappingURL=knowledge-resolver.d.ts.map