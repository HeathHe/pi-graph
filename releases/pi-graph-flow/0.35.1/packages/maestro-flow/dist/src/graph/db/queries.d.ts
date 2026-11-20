import type { DatabaseConnection } from './connection.js';
import type { EnhancedNode, EnhancedEdge, FileRecord, UnresolvedReference, NodeKind, EdgeKind, Language, GraphStats } from '../types.js';
export declare class QueryBuilder {
    private conn;
    private stmtCache;
    constructor(conn: DatabaseConnection);
    private stmt;
    getNodeById(id: string): EnhancedNode | null;
    getNodesByIds(ids: string[]): Map<string, EnhancedNode>;
    getNodesByFile(filePath: string): EnhancedNode[];
    getNodesByKind(kind: NodeKind): EnhancedNode[];
    insertNode(node: EnhancedNode): void;
    insertNodes(nodes: EnhancedNode[]): void;
    deleteNode(id: string): void;
    deleteNodesByFile(filePath: string): void;
    getOutgoingEdges(nodeId: string, kinds?: EdgeKind[]): EnhancedEdge[];
    getIncomingEdges(nodeId: string, kinds?: EdgeKind[]): EnhancedEdge[];
    insertEdge(edge: EnhancedEdge): void;
    insertEdges(edges: EnhancedEdge[]): void;
    deleteEdgesFrom(source: string): void;
    deleteEdgesForFile(filePath: string): void;
    getFile(path: string): FileRecord | null;
    getAllFiles(): FileRecord[];
    upsertFile(file: FileRecord): void;
    deleteFile(path: string): void;
    getStaleFiles(currentHashes: Map<string, string>): {
        added: string[];
        modified: string[];
        deleted: string[];
    };
    insertUnresolvedRef(ref: UnresolvedReference): void;
    deleteUnresolvedRefsForFile(filePath: string): void;
    getUnresolvedReferencesCount(): number;
    searchNodes(query: string, options?: {
        kinds?: NodeKind[];
        languages?: Language[];
        pathFilters?: string[];
        nameFilters?: string[];
        limit?: number;
    }): EnhancedNode[];
    getStats(dbSizeBytes?: number): GraphStats;
    getNodeAndEdgeCount(): {
        nodes: number;
        edges: number;
    };
    setMetadata(key: string, value: string): void;
    getMetadata(key: string): string | null;
    clear(): void;
}
//# sourceMappingURL=queries.d.ts.map