import type { EnhancedNode, EnhancedEdge, Subgraph, TraversalOptions, EdgeKind } from './types.js';
import type { QueryBuilder } from './db/queries.js';
export declare class GraphTraverser {
    private queries;
    constructor(queries: QueryBuilder);
    traverseBFS(startId: string, options?: TraversalOptions): Subgraph;
    traverseDFS(startId: string, options?: TraversalOptions): Subgraph;
    private dfsRecursive;
    private getAdjacentEdges;
    getCallers(nodeId: string, maxDepth?: number): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge;
    }>;
    private getCallersRecursive;
    getCallees(nodeId: string, maxDepth?: number): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge;
    }>;
    private getCalleesRecursive;
    getCallGraph(nodeId: string, depth?: number): Subgraph;
    getTypeHierarchy(nodeId: string): Subgraph;
    private getTypeAncestors;
    private getTypeDescendants;
    findUsages(nodeId: string): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge;
    }>;
    getImpactRadius(nodeId: string, maxDepth?: number): Subgraph;
    private getImpactRecursive;
    findPath(fromId: string, toId: string, edgeKinds?: EdgeKind[]): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge | null;
    }> | null;
    getAncestors(nodeId: string): EnhancedNode[];
    getChildren(nodeId: string): EnhancedNode[];
}
//# sourceMappingURL=traversal.d.ts.map