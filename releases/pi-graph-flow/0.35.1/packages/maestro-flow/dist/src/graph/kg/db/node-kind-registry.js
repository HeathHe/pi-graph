import { CODE_NODE_KINDS, KNOWLEDGE_NODE_KINDS } from './types.js';
class NodeKindRegistryImpl {
    registry = new Map();
    constructor() {
        for (const kind of CODE_NODE_KINDS) {
            this.registry.set(kind, { category: 'code' });
        }
        for (const kind of KNOWLEDGE_NODE_KINDS) {
            this.registry.set(kind, { category: 'knowledge' });
        }
    }
    register(kind, meta) {
        if (this.registry.has(kind))
            return;
        this.registry.set(kind, { category: 'custom', ...meta });
    }
    unregister(kind) {
        const meta = this.registry.get(kind);
        if (!meta || meta.category !== 'custom')
            return false;
        return this.registry.delete(kind);
    }
    isValid(kind) {
        return this.registry.has(kind);
    }
    getAll() {
        return Array.from(this.registry.keys());
    }
    getByCategory(category) {
        return Array.from(this.registry.entries())
            .filter(([, meta]) => meta.category === category)
            .map(([kind]) => kind);
    }
    getMeta(kind) {
        return this.registry.get(kind);
    }
    get size() {
        return this.registry.size;
    }
}
export const NodeKindRegistry = new NodeKindRegistryImpl();
//# sourceMappingURL=node-kind-registry.js.map