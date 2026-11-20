export interface NodeKindMeta {
    category: 'code' | 'knowledge' | 'custom';
    description?: string;
}
declare class NodeKindRegistryImpl {
    private registry;
    constructor();
    register(kind: string, meta?: Partial<NodeKindMeta>): void;
    unregister(kind: string): boolean;
    isValid(kind: string): boolean;
    getAll(): string[];
    getByCategory(category: NodeKindMeta['category']): string[];
    getMeta(kind: string): NodeKindMeta | undefined;
    get size(): number;
}
export declare const NodeKindRegistry: NodeKindRegistryImpl;
export type { NodeKindRegistryImpl };
//# sourceMappingURL=node-kind-registry.d.ts.map