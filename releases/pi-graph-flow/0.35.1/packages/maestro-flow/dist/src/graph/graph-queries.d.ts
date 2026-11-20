import type { EnhancedNode, NodeContext, NodeKind } from './types.js';
import type { QueryBuilder } from './db/queries.js';
import { GraphTraverser } from './traversal.js';
export declare class GraphQueryManager {
    private queries;
    private traverser;
    constructor(queries: QueryBuilder);
    getTraverser(): GraphTraverser;
    getContext(nodeId: string): NodeContext;
    getFileDependencies(filePath: string): string[];
    getFileDependents(filePath: string): string[];
    getExportedSymbols(filePath: string): EnhancedNode[];
    findCircularDependencies(): string[][];
    findDeadCode(kinds?: NodeKind[]): EnhancedNode[];
    getNodeMetrics(nodeId: string): {
        incomingEdgeCount: number;
        outgoingEdgeCount: number;
        callCount: number;
        callerCount: number;
        childCount: number;
        depth: number;
    };
}
//# sourceMappingURL=graph-queries.d.ts.map