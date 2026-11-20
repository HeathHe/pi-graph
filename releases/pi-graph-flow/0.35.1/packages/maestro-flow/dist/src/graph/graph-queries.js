import { GraphTraverser } from './traversal.js';
export class GraphQueryManager {
    queries;
    traverser;
    constructor(queries) {
        this.queries = queries;
        this.traverser = new GraphTraverser(queries);
    }
    getTraverser() {
        return this.traverser;
    }
    getContext(nodeId) {
        const focal = this.queries.getNodeById(nodeId);
        if (!focal)
            throw new Error(`Node not found: ${nodeId}`);
        const ancestors = this.traverser.getAncestors(nodeId);
        const children = this.traverser.getChildren(nodeId);
        const incomingEdges = this.queries.getIncomingEdges(nodeId);
        const incomingRefs = [];
        const inSourceIds = incomingEdges.filter(e => e.kind !== 'contains').map(e => e.source);
        const inSources = inSourceIds.length > 0 ? this.queries.getNodesByIds(inSourceIds) : new Map();
        for (const edge of incomingEdges) {
            if (edge.kind === 'contains')
                continue;
            const node = inSources.get(edge.source);
            if (node)
                incomingRefs.push({ node, edge });
        }
        const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
        const outgoingRefs = [];
        const outTargetIds = outgoingEdges.filter(e => e.kind !== 'contains').map(e => e.target);
        const outTargets = outTargetIds.length > 0 ? this.queries.getNodesByIds(outTargetIds) : new Map();
        for (const edge of outgoingEdges) {
            if (edge.kind === 'contains')
                continue;
            const node = outTargets.get(edge.target);
            if (node)
                outgoingRefs.push({ node, edge });
        }
        const types = [];
        const typeEdgeKinds = ['type_of', 'returns'];
        for (const kind of typeEdgeKinds) {
            const typeEdges = this.queries.getOutgoingEdges(nodeId, [kind]);
            const typeNodes = typeEdges.length > 0
                ? this.queries.getNodesByIds(typeEdges.map(e => e.target))
                : new Map();
            for (const edge of typeEdges) {
                const typeNode = typeNodes.get(edge.target);
                if (typeNode && !types.some(t => t.id === typeNode.id))
                    types.push(typeNode);
            }
        }
        const imports = [];
        const fileNode = ancestors.find(a => a.kind === 'file');
        if (fileNode) {
            const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
            const importNodes = importEdges.length > 0
                ? this.queries.getNodesByIds(importEdges.map(e => e.target))
                : new Map();
            for (const edge of importEdges) {
                const importNode = importNodes.get(edge.target);
                if (importNode)
                    imports.push(importNode);
            }
        }
        return { focal, ancestors, children, incomingRefs, outgoingRefs, types, imports };
    }
    getFileDependencies(filePath) {
        const nodes = this.queries.getNodesByFile(filePath);
        const fileNode = nodes.find(n => n.kind === 'file');
        if (!fileNode)
            return [];
        const dependencies = new Set();
        const importEdges = this.queries.getOutgoingEdges(fileNode.id, ['imports']);
        const targetIds = importEdges.map(e => e.target);
        const targets = targetIds.length > 0 ? this.queries.getNodesByIds(targetIds) : new Map();
        for (const edge of importEdges) {
            const targetNode = targets.get(edge.target);
            if (targetNode && targetNode.filePath !== filePath)
                dependencies.add(targetNode.filePath);
        }
        return Array.from(dependencies);
    }
    getFileDependents(filePath) {
        const nodes = this.queries.getNodesByFile(filePath);
        const dependents = new Set();
        const fileNode = nodes.find(n => n.kind === 'file');
        if (fileNode) {
            const incomingEdges = this.queries.getIncomingEdges(fileNode.id, ['imports']);
            const sourceIds = incomingEdges.map(e => e.source);
            const sources = sourceIds.length > 0 ? this.queries.getNodesByIds(sourceIds) : new Map();
            for (const edge of incomingEdges) {
                const sourceNode = sources.get(edge.source);
                if (sourceNode && sourceNode.filePath !== filePath)
                    dependents.add(sourceNode.filePath);
            }
        }
        for (const node of nodes) {
            if (node.isExported) {
                const incomingEdges = this.queries.getIncomingEdges(node.id, ['imports']);
                const sourceIds = incomingEdges.map(e => e.source);
                const sources = sourceIds.length > 0 ? this.queries.getNodesByIds(sourceIds) : new Map();
                for (const edge of incomingEdges) {
                    const sourceNode = sources.get(edge.source);
                    if (sourceNode && sourceNode.filePath !== filePath)
                        dependents.add(sourceNode.filePath);
                }
            }
        }
        return Array.from(dependents);
    }
    getExportedSymbols(filePath) {
        const nodes = this.queries.getNodesByFile(filePath);
        return nodes.filter(n => n.isExported);
    }
    findCircularDependencies() {
        const files = this.queries.getAllFiles();
        const cycles = [];
        const visited = new Set();
        const recursionStack = new Set();
        const dfs = (filePath, path) => {
            if (recursionStack.has(filePath)) {
                const cycleStart = path.indexOf(filePath);
                if (cycleStart !== -1)
                    cycles.push(path.slice(cycleStart));
                return;
            }
            if (visited.has(filePath))
                return;
            visited.add(filePath);
            recursionStack.add(filePath);
            const dependencies = this.getFileDependencies(filePath);
            for (const dep of dependencies)
                dfs(dep, [...path, filePath]);
            recursionStack.delete(filePath);
        };
        for (const file of files) {
            if (!visited.has(file.path))
                dfs(file.path, []);
        }
        return cycles;
    }
    findDeadCode(kinds) {
        const targetKinds = kinds ?? ['function', 'method', 'class'];
        const deadCode = [];
        for (const kind of targetKinds) {
            const nodes = this.queries.getNodesByKind(kind);
            for (const node of nodes) {
                if (node.isExported)
                    continue;
                const incomingEdges = this.queries.getIncomingEdges(node.id);
                const references = incomingEdges.filter(e => e.kind !== 'contains');
                if (references.length === 0)
                    deadCode.push(node);
            }
        }
        return deadCode;
    }
    getNodeMetrics(nodeId) {
        const incomingEdges = this.queries.getIncomingEdges(nodeId);
        const outgoingEdges = this.queries.getOutgoingEdges(nodeId);
        const ancestors = this.traverser.getAncestors(nodeId);
        return {
            incomingEdgeCount: incomingEdges.length,
            outgoingEdgeCount: outgoingEdges.length,
            callCount: outgoingEdges.filter(e => e.kind === 'calls').length,
            callerCount: incomingEdges.filter(e => e.kind === 'calls').length,
            childCount: outgoingEdges.filter(e => e.kind === 'contains').length,
            depth: ancestors.length,
        };
    }
}
//# sourceMappingURL=graph-queries.js.map