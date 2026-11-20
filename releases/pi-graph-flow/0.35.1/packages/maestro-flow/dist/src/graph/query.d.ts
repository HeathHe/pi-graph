import type { KnowledgeGraph, GraphNode, PathResult, DiffResult, SearchOptions } from './types.js';
export declare function truncate(text: string, maxLen: number): string;
export declare function countBy<T>(items: T[], keyFn: (item: T) => string): Record<string, number>;
export declare function searchNodes(graph: KnowledgeGraph, query: string, opts?: SearchOptions): GraphNode[];
export declare function findPath(graph: KnowledgeGraph, fromId: string, toId: string): PathResult;
export declare function diffChanges(graph: KnowledgeGraph, changedFiles: string[]): DiffResult;
//# sourceMappingURL=query.d.ts.map