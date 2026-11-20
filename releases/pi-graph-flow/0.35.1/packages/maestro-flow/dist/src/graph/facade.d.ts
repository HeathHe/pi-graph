import type { EnhancedNode, EnhancedEdge, Subgraph, GraphStats, NodeKind, NodeContext, PathResult, DiffResult } from './types.js';
export type GraphBackend = 'sqlite' | 'json' | 'none';
export declare function detectBackend(projectRoot?: string): GraphBackend;
export declare class GraphFacade {
    private backend;
    private conn;
    private queries;
    private manager;
    private traverser;
    private jsonGraph;
    constructor(projectRoot?: string);
    getBackend(): GraphBackend;
    close(): void;
    search(query: string, opts?: {
        limit?: number;
        type?: string;
    }): Array<{
        id: string;
        kind: string;
        name: string;
        filePath?: string;
        summary?: string;
    }>;
    findPath(fromId: string, toId: string): PathResult | null;
    diffChanges(changedFiles: string[]): DiffResult;
    stats(): GraphStats | null;
    getCallers(nodeId: string, depth?: number): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge;
    }>;
    getCallees(nodeId: string, depth?: number): Array<{
        node: EnhancedNode;
        edge: EnhancedEdge;
    }>;
    getImpactRadius(nodeId: string, depth?: number): Subgraph;
    findDeadCode(kinds?: NodeKind[]): EnhancedNode[];
    findCircularDependencies(): string[][];
    getContext(nodeId: string): NodeContext;
    getNodeMetrics(nodeId: string): {
        incomingEdgeCount: number;
        outgoingEdgeCount: number;
        callCount: number;
        callerCount: number;
        childCount: number;
        depth: number;
    };
    sync(): {
        filesChanged: number;
        durationMs: number;
    };
    private requireSqlite;
}
//# sourceMappingURL=facade.d.ts.map