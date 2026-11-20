import type { KgQueryBuilder } from '../db/queries.js';
import type { UnifiedNode, UnifiedEdge } from '../db/types.js';
export interface TraversalResult {
    nodes: Map<string, UnifiedNode>;
    edges: UnifiedEdge[];
    visited: Set<string>;
}
export type ImpactDirection = 'outgoing' | 'incoming';
export interface ImpactResult extends TraversalResult {
    depth: number;
    traversalDirection: ImpactDirection;
    truncated: boolean;
}
export type HierarchyDirection = 'parents' | 'children' | 'both';
export interface TypeHierarchyResult extends TraversalResult {
    root: UnifiedNode | null;
    parents: UnifiedNode[];
    children: UnifiedNode[];
    rawEdges: UnifiedEdge[];
    depth: number;
    direction: HierarchyDirection;
    truncated: boolean;
}
export declare function normalizeTraversalDepth(value: unknown, fallback: number, max: number): number;
export interface TraversalOptions {
    /** 最大深度 */
    maxDepth?: number;
    /** 边类型过滤 */
    edgeKinds?: string[];
    /** 方向: outgoing/incoming/both */
    direction?: 'outgoing' | 'incoming' | 'both';
    /** 最大节点数限制 */
    maxNodes?: number;
}
export declare function bfs(queries: KgQueryBuilder, startNodeId: string, options?: TraversalOptions): TraversalResult;
export declare function traceCallChain(queries: KgQueryBuilder, startSymbol: string, options?: {
    maxDepth?: number;
    edgeKinds?: string[];
}): TraversalResult;
export declare function getCallers(queries: KgQueryBuilder, nodeId: string, depth?: number): Array<{
    node: UnifiedNode;
    edge: UnifiedEdge;
}>;
export declare function getCallees(queries: KgQueryBuilder, nodeId: string, depth?: number): Array<{
    node: UnifiedNode;
    edge: UnifiedEdge;
}>;
export declare function getImpactRadius(queries: KgQueryBuilder, nodeId: string, depth?: number, direction?: ImpactDirection): ImpactResult;
export declare function dfs(queries: KgQueryBuilder, startNodeId: string, options?: TraversalOptions): TraversalResult;
export declare function getTypeHierarchy(queries: KgQueryBuilder, nodeId: string, options?: {
    direction?: HierarchyDirection;
    depth?: number;
    maxNodes?: number;
}): TypeHierarchyResult;
export declare function findUsages(queries: KgQueryBuilder, nodeId: string): Array<{
    node: UnifiedNode;
    edge: UnifiedEdge;
}>;
export declare function getAncestors(queries: KgQueryBuilder, nodeId: string): UnifiedNode[];
export declare function getChildren(queries: KgQueryBuilder, nodeId: string): UnifiedNode[];
export declare function getCallGraph(queries: KgQueryBuilder, nodeId: string, depth?: number): TraversalResult;
export interface NodeContext {
    focal: UnifiedNode;
    ancestors: UnifiedNode[];
    children: UnifiedNode[];
    incomingRefs: Array<{
        node: UnifiedNode;
        edge: UnifiedEdge;
    }>;
    outgoingRefs: Array<{
        node: UnifiedNode;
        edge: UnifiedEdge;
    }>;
    typeHierarchy: TypeHierarchyResult;
}
export declare function getNodeContext(queries: KgQueryBuilder, nodeId: string): NodeContext | null;
export declare function getFileDependencies(queries: KgQueryBuilder, filePath: string): string[];
export declare function getFileDependents(queries: KgQueryBuilder, filePath: string): string[];
export declare function findDeadCode(queries: KgQueryBuilder, options?: {
    kinds?: string[];
}): UnifiedNode[];
export interface NodeMetrics {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
}
export declare function getNodeMetrics(queries: KgQueryBuilder, nodeId: string): NodeMetrics | null;
export interface PathStep {
    nodeId: string;
    edge: UnifiedEdge | null;
    traversalDirection?: 'outgoing' | 'incoming' | null;
}
export interface PathSearchResult {
    path: PathStep[] | null;
    truncated: boolean;
    visitedCount: number;
}
export declare function findShortestPath(queries: KgQueryBuilder, fromId: string, toId: string, maxDepth?: number): PathStep[] | null;
export declare function findShortestPathResult(queries: KgQueryBuilder, fromId: string, toId: string, maxDepth?: number, maxNodes?: number): PathSearchResult;
//# sourceMappingURL=traversal.d.ts.map