// src/graph/kg/query/traversal.ts — 图遍历 (BFS/DFS)
// 参考: codegraph/src/graph/traversal.ts
export function normalizeTraversalDepth(value, fallback, max) {
    const parsed = typeof value === 'number' ? value : Number(value);
    const candidate = Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
    return Math.max(0, Math.min(candidate, max));
}
// ---------------------------------------------------------------------------
// BFS 广度优先遍历
// ---------------------------------------------------------------------------
export function bfs(queries, startNodeId, options) {
    const maxDepth = options?.maxDepth ?? 2;
    const direction = options?.direction ?? 'both';
    const maxNodes = options?.maxNodes ?? 200;
    const edgeKinds = options?.edgeKinds ? new Set(options.edgeKinds) : null;
    const visited = new Set([startNodeId]);
    const nodes = new Map();
    const edges = [];
    // 加载起始节点
    const startNode = queries.getNode(startNodeId);
    if (startNode)
        nodes.set(startNodeId, startNode);
    let frontier = [startNodeId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        if (nodes.size >= maxNodes)
            break;
        // 批量获取整层 frontier 的邻居边
        const neighbors = getNeighborsBatch(queries, frontier, direction, edgeKinds);
        const nextFrontier = [];
        const neighborIdsToLoad = [];
        for (const { edge, neighborId } of neighbors) {
            if (nodes.size + neighborIdsToLoad.length >= maxNodes)
                break;
            if (visited.has(neighborId))
                continue;
            visited.add(neighborId);
            nextFrontier.push(neighborId);
            neighborIdsToLoad.push(neighborId);
            edges.push(edge);
        }
        // 批量加载邻居节点
        if (neighborIdsToLoad.length > 0) {
            const loadedNodes = queries.getNodesByIds(neighborIdsToLoad);
            loadedNodes.forEach((node, id) => {
                nodes.set(id, node);
            });
        }
        frontier = nextFrontier;
    }
    return { nodes, edges, visited };
}
// ---------------------------------------------------------------------------
// 调用链追踪 (A→B→C→D)
// ---------------------------------------------------------------------------
export function traceCallChain(queries, startSymbol, options) {
    return bfs(queries, startSymbol, {
        maxDepth: options?.maxDepth ?? 5,
        direction: 'outgoing',
        edgeKinds: options?.edgeKinds ?? ['calls', 'imports'],
        maxNodes: 100,
    });
}
// ---------------------------------------------------------------------------
// 调用方/被调用方
// ---------------------------------------------------------------------------
export function getCallers(queries, nodeId, depth = 1) {
    const result = bfs(queries, nodeId, {
        maxDepth: depth,
        direction: 'incoming',
        edgeKinds: ['calls'],
        maxNodes: 50,
    });
    const callers = [];
    for (const edge of result.edges) {
        const node = result.nodes.get(edge.source);
        if (node)
            callers.push({ node, edge });
    }
    return callers;
}
export function getCallees(queries, nodeId, depth = 1) {
    const result = bfs(queries, nodeId, {
        maxDepth: depth,
        direction: 'outgoing',
        edgeKinds: ['calls'],
        maxNodes: 50,
    });
    const callees = [];
    for (const edge of result.edges) {
        const node = result.nodes.get(edge.target);
        if (node)
            callees.push({ node, edge });
    }
    return callees;
}
// ---------------------------------------------------------------------------
// 影响半径分析
// ---------------------------------------------------------------------------
export function getImpactRadius(queries, nodeId, depth = 3, direction = 'outgoing') {
    const maxDepth = normalizePublicDepth(depth, 3);
    const edgeKinds = new Set(['calls', 'imports', 'extends', 'implements', 'references']);
    const visited = new Set([nodeId]);
    const nodes = new Map();
    const rawEdges = new Map();
    const startNode = queries.getNode(nodeId);
    if (startNode)
        nodes.set(nodeId, startNode);
    let truncated = false;
    let frontier = [nodeId];
    for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
        const edgesByNode = direction === 'outgoing'
            ? queries.getOutgoingEdgesBatch(frontier)
            : queries.getIncomingEdgesBatch(frontier);
        const next = [];
        scanLevel: for (const currentId of frontier) {
            const adjacent = (edgesByNode.get(currentId) ?? []).slice().sort(compareEdges);
            for (const edge of adjacent) {
                if (!edgeKinds.has(edge.kind))
                    continue;
                const neighborId = direction === 'outgoing' ? edge.target : edge.source;
                const isNew = !visited.has(neighborId);
                if (isNew && visited.size >= 200) {
                    truncated = true;
                    break scanLevel;
                }
                rawEdges.set(edgeIdentity(edge), edge);
                if (!isNew)
                    continue;
                visited.add(neighborId);
                next.push(neighborId);
            }
        }
        queries.getNodesByIds(next).forEach((node, id) => nodes.set(id, node));
        frontier = next.sort(compareBytes);
        if (truncated)
            break;
    }
    if (!truncated && frontier.length > 0) {
        truncated = hasUnvisitedNeighbor(queries, frontier, direction, edgeKinds, visited);
    }
    return {
        nodes,
        edges: [...rawEdges.values()].sort(compareEdges),
        visited,
        depth: maxDepth,
        traversalDirection: direction,
        truncated,
    };
}
// ---------------------------------------------------------------------------
// DFS 深度优先遍历
// ---------------------------------------------------------------------------
export function dfs(queries, startNodeId, options) {
    const maxDepth = options?.maxDepth ?? 2;
    const direction = options?.direction ?? 'both';
    const maxNodes = options?.maxNodes ?? 200;
    const edgeKinds = options?.edgeKinds ? new Set(options.edgeKinds) : null;
    const visited = new Set([startNodeId]);
    const nodes = new Map();
    const edges = [];
    const startNode = queries.getNode(startNodeId);
    if (startNode)
        nodes.set(startNodeId, startNode);
    function visit(nodeId, depth) {
        if (depth >= maxDepth || nodes.size >= maxNodes)
            return;
        const neighbors = getNeighbors(queries, nodeId, direction, edgeKinds);
        for (const { edge, neighborId } of neighbors) {
            if (nodes.size >= maxNodes)
                return;
            if (visited.has(neighborId))
                continue;
            visited.add(neighborId);
            edges.push(edge);
            const node = queries.getNode(neighborId);
            if (node)
                nodes.set(neighborId, node);
            visit(neighborId, depth + 1);
        }
    }
    visit(startNodeId, 0);
    return { nodes, edges, visited };
}
// ---------------------------------------------------------------------------
// 类型继承树 — extends/implements 双向完整遍历
// ---------------------------------------------------------------------------
export function getTypeHierarchy(queries, nodeId, options = {}) {
    const direction = options.direction ?? 'both';
    // 旧版 API 默认遍历到可达边界；省略 depth 时保留该语义。
    // CLI/MCP 会显式传入深度上限，并通过 truncated 暴露未遍历完的路径。
    const requestedDepth = options.depth === undefined
        ? null
        : normalizePublicDepth(options.depth, 10);
    const depthLimit = requestedDepth ?? Number.POSITIVE_INFINITY;
    const nodeLimit = normalizeOptionalNodeLimit(options.maxNodes);
    const edgeKindSet = new Set(['extends', 'implements']);
    const allVisited = new Set([nodeId]);
    const nodes = new Map();
    const rawEdges = new Map();
    const parentIds = new Set();
    const childIds = new Set();
    let nodeLimitTruncated = false;
    let depthTruncated = false;
    let reachedDepth = 0;
    const startNode = queries.getNode(nodeId);
    if (startNode)
        nodes.set(nodeId, startNode);
    // inheritance edges are stored child(source) -> parent(target).
    if (direction === 'parents' || direction === 'both') {
        const visited = new Set([nodeId]);
        let frontier = [nodeId];
        for (let level = 0; level < depthLimit && frontier.length > 0 && !nodeLimitTruncated; level++) {
            const outgoingByNode = queries.getOutgoingEdgesBatch(frontier);
            const next = [];
            scanParents: for (const currentId of frontier) {
                const outgoing = (outgoingByNode.get(currentId) ?? []).slice().sort(compareEdges);
                for (const edge of outgoing) {
                    if (!edgeKindSet.has(edge.kind))
                        continue;
                    const isNewToDirection = !visited.has(edge.target);
                    const isNewToHierarchy = !allVisited.has(edge.target);
                    if (isNewToDirection
                        && isNewToHierarchy
                        && nodeLimit !== null
                        && allVisited.size >= nodeLimit) {
                        nodeLimitTruncated = true;
                        break scanParents;
                    }
                    rawEdges.set(edgeIdentity(edge), edge);
                    if (!isNewToDirection)
                        continue;
                    visited.add(edge.target);
                    if (isNewToHierarchy)
                        allVisited.add(edge.target);
                    parentIds.add(edge.target);
                    next.push(edge.target);
                }
            }
            queries.getNodesByIds(next).forEach((node, id) => nodes.set(id, node));
            frontier = next.sort(compareBytes);
            if (frontier.length > 0)
                reachedDepth = Math.max(reachedDepth, level + 1);
        }
        if (requestedDepth !== null && !nodeLimitTruncated && frontier.length > 0) {
            depthTruncated ||= hasUnvisitedNeighbor(queries, frontier, 'outgoing', edgeKindSet, visited);
        }
    }
    if ((direction === 'children' || direction === 'both') && !nodeLimitTruncated) {
        const visited = new Set([nodeId]);
        let frontier = [nodeId];
        for (let level = 0; level < depthLimit && frontier.length > 0 && !nodeLimitTruncated; level++) {
            const incomingByNode = queries.getIncomingEdgesBatch(frontier);
            const next = [];
            scanChildren: for (const currentId of frontier) {
                const incoming = (incomingByNode.get(currentId) ?? []).slice().sort(compareEdges);
                for (const edge of incoming) {
                    if (!edgeKindSet.has(edge.kind))
                        continue;
                    const isNewToDirection = !visited.has(edge.source);
                    const isNewToHierarchy = !allVisited.has(edge.source);
                    if (isNewToDirection
                        && isNewToHierarchy
                        && nodeLimit !== null
                        && allVisited.size >= nodeLimit) {
                        nodeLimitTruncated = true;
                        break scanChildren;
                    }
                    rawEdges.set(edgeIdentity(edge), edge);
                    if (!isNewToDirection)
                        continue;
                    visited.add(edge.source);
                    if (isNewToHierarchy)
                        allVisited.add(edge.source);
                    childIds.add(edge.source);
                    next.push(edge.source);
                }
            }
            queries.getNodesByIds(next).forEach((node, id) => nodes.set(id, node));
            frontier = next.sort(compareBytes);
            if (frontier.length > 0)
                reachedDepth = Math.max(reachedDepth, level + 1);
        }
        if (requestedDepth !== null && !nodeLimitTruncated && frontier.length > 0) {
            depthTruncated ||= hasUnvisitedNeighbor(queries, frontier, 'incoming', edgeKindSet, visited);
        }
    }
    const parents = [...parentIds]
        .map(id => nodes.get(id))
        .filter((node) => Boolean(node))
        .sort((left, right) => compareBytes(left.id, right.id));
    const children = [...childIds]
        .map(id => nodes.get(id))
        .filter((node) => Boolean(node))
        .sort((left, right) => compareBytes(left.id, right.id));
    const edges = [...rawEdges.values()].sort(compareEdges);
    return {
        root: startNode,
        parents,
        children,
        rawEdges: edges,
        depth: requestedDepth ?? reachedDepth,
        direction,
        truncated: nodeLimitTruncated || depthTruncated,
        nodes,
        edges,
        visited: allVisited,
    };
}
function hasUnvisitedNeighbor(queries, nodeIds, direction, edgeKinds, visited) {
    return getNeighborsBatch(queries, nodeIds, direction, edgeKinds)
        .some(({ neighborId }) => !visited.has(neighborId));
}
// ---------------------------------------------------------------------------
// 查找所有使用点 — 所有 incoming edge 的 source 节点
// ---------------------------------------------------------------------------
export function findUsages(queries, nodeId) {
    const incoming = queries.getIncomingEdges(nodeId);
    const nodes = queries.getNodesByIds(incoming.map(edge => edge.source));
    const result = [];
    for (const edge of incoming) {
        const node = nodes.get(edge.source);
        if (node)
            result.push({ node, edge });
    }
    return result;
}
// ---------------------------------------------------------------------------
// 祖先链 — 沿 contains 边向上回溯
// ---------------------------------------------------------------------------
export function getAncestors(queries, nodeId) {
    const ancestors = [];
    const seen = new Set([nodeId]);
    let current = nodeId;
    while (true) {
        const incoming = queries.getIncomingEdges(current);
        const containsEdge = incoming.find(e => e.kind === 'contains' && !seen.has(e.source));
        if (!containsEdge)
            break;
        seen.add(containsEdge.source);
        const parent = queries.getNode(containsEdge.source);
        if (!parent)
            break;
        ancestors.push(parent);
        current = containsEdge.source;
    }
    return ancestors;
}
// ---------------------------------------------------------------------------
// 直接子节点 — contains 边的 target
// ---------------------------------------------------------------------------
export function getChildren(queries, nodeId) {
    const outgoing = queries.getOutgoingEdges(nodeId);
    const nodes = queries.getNodesByIds(outgoing.filter(edge => edge.kind === 'contains').map(edge => edge.target));
    const children = [];
    for (const edge of outgoing) {
        if (edge.kind !== 'contains')
            continue;
        const child = nodes.get(edge.target);
        if (child)
            children.push(child);
    }
    return children;
}
// ---------------------------------------------------------------------------
// 双向调用图 — callers + callees 合并为完整子图
// ---------------------------------------------------------------------------
export function getCallGraph(queries, nodeId, depth = 2) {
    return bfs(queries, nodeId, {
        maxDepth: depth,
        direction: 'both',
        edgeKinds: ['calls', 'references', 'imports'],
        maxNodes: 200,
    });
}
export function getNodeContext(queries, nodeId) {
    const focal = queries.getNode(nodeId);
    if (!focal)
        return null;
    const ancestors = getAncestors(queries, nodeId);
    const children = getChildren(queries, nodeId);
    const incomingRefs = [];
    for (const edge of queries.getIncomingEdges(nodeId)) {
        if (edge.kind === 'contains')
            continue;
        const node = queries.getNode(edge.source);
        if (node)
            incomingRefs.push({ node, edge });
    }
    const outgoingRefs = [];
    for (const edge of queries.getOutgoingEdges(nodeId)) {
        if (edge.kind === 'contains')
            continue;
        const node = queries.getNode(edge.target);
        if (node)
            outgoingRefs.push({ node, edge });
    }
    const typeHierarchy = getTypeHierarchy(queries, nodeId);
    return { focal, ancestors, children, incomingRefs, outgoingRefs, typeHierarchy };
}
// ---------------------------------------------------------------------------
// 文件级依赖 — imports 边聚合到文件层
// ---------------------------------------------------------------------------
export function getFileDependencies(queries, filePath) {
    const fileNodes = queries.getNodesByFile(filePath);
    const depFiles = new Set();
    const outgoingByNode = queries.getOutgoingEdgesBatch(fileNodes.map(node => node.id));
    const targetIds = [];
    for (const outgoing of outgoingByNode.values()) {
        for (const edge of outgoing) {
            if (edge.kind === 'imports')
                targetIds.push(edge.target);
        }
    }
    for (const target of queries.getNodesByIds(targetIds).values()) {
        if (target.filePath && target.filePath !== filePath)
            depFiles.add(target.filePath);
    }
    return [...depFiles];
}
export function getFileDependents(queries, filePath) {
    const fileNodes = queries.getNodesByFile(filePath);
    const depFiles = new Set();
    const incomingByNode = queries.getIncomingEdgesBatch(fileNodes.map(node => node.id));
    const sourceIds = [];
    for (const incoming of incomingByNode.values()) {
        for (const edge of incoming) {
            if (edge.kind === 'imports')
                sourceIds.push(edge.source);
        }
    }
    for (const source of queries.getNodesByIds(sourceIds).values()) {
        if (source.filePath && source.filePath !== filePath)
            depFiles.add(source.filePath);
    }
    return [...depFiles];
}
// ---------------------------------------------------------------------------
// 死代码检测 — 无引用的非导出符号
// ---------------------------------------------------------------------------
export function findDeadCode(queries, options) {
    const allNodes = queries.searchCodeFTS('*', { limit: 10000 });
    const deadNodes = [];
    const kinds = options?.kinds ? new Set(options.kinds) : null;
    const incomingByNode = queries.getIncomingEdgesBatch(allNodes.map(node => node.id));
    for (const node of allNodes) {
        if (kinds && !kinds.has(node.kind))
            continue;
        if (node.isExported)
            continue;
        const incoming = incomingByNode.get(node.id) ?? [];
        const hasExternalRef = incoming.some(e => e.kind !== 'contains');
        if (!hasExternalRef)
            deadNodes.push(node);
    }
    return deadNodes;
}
export function getNodeMetrics(queries, nodeId) {
    const node = queries.getNode(nodeId);
    if (!node)
        return null;
    const incoming = queries.getIncomingEdges(nodeId);
    const outgoing = queries.getOutgoingEdges(nodeId);
    return {
        incomingEdgeCount: incoming.length,
        outgoingEdgeCount: outgoing.length,
        callCount: outgoing.filter(e => e.kind === 'calls').length,
        callerCount: incoming.filter(e => e.kind === 'calls').length,
        childCount: outgoing.filter(e => e.kind === 'contains').length,
        depth: getAncestors(queries, nodeId).length,
    };
}
export function findShortestPath(queries, fromId, toId, maxDepth = 10) {
    return findShortestPathResult(queries, fromId, toId, maxDepth).path;
}
export function findShortestPathResult(queries, fromId, toId, maxDepth = 10, maxNodes) {
    if (fromId === toId) {
        const exists = Boolean(queries.getNode(fromId));
        return {
            path: exists ? [{ nodeId: fromId, edge: null, traversalDirection: null }] : null,
            truncated: false,
            visitedCount: exists ? 1 : 0,
        };
    }
    const visited = new Set([fromId]);
    const parent = new Map();
    const depthLimit = normalizePublicDepth(maxDepth, 10);
    const nodeLimit = normalizeOptionalNodeLimit(maxNodes);
    let frontier = [fromId];
    for (let depth = 0; depth < depthLimit && frontier.length > 0; depth++) {
        const nextFrontier = [];
        const neighbors = getNeighborsBatch(queries, frontier, 'both', null)
            .sort((left, right) => (compareBytes(left.neighborId, right.neighborId)
            || compareEdges(left.edge, right.edge)
            || compareBytes(left.fromNodeId, right.fromNodeId)));
        for (const { neighborId, edge, fromNodeId, traversalDirection } of neighbors) {
            if (visited.has(neighborId))
                continue;
            if (nodeLimit !== null && visited.size >= nodeLimit) {
                return { path: null, truncated: true, visitedCount: visited.size };
            }
            visited.add(neighborId);
            parent.set(neighborId, { from: fromNodeId, edge, traversalDirection });
            nextFrontier.push(neighborId);
            if (neighborId === toId) {
                const reversePath = [];
                let current = toId;
                while (parent.has(current)) {
                    const previous = parent.get(current);
                    reversePath.push({
                        nodeId: current,
                        edge: previous.edge,
                        traversalDirection: previous.traversalDirection,
                    });
                    current = previous.from;
                }
                reversePath.push({ nodeId: fromId, edge: null, traversalDirection: null });
                return {
                    path: reversePath.reverse(),
                    truncated: false,
                    visitedCount: visited.size,
                };
            }
        }
        frontier = nextFrontier;
    }
    return {
        path: null,
        // 达到深度上限后仅在仍有未访问邻居时标记截断，叶子 frontier 不算截断。
        truncated: frontier.length > 0
            && hasUnvisitedNeighbor(queries, frontier, 'both', null, visited),
        visitedCount: visited.size,
    };
}
function getNeighbors(queries, nodeId, direction, edgeKinds) {
    const neighbors = [];
    if (direction === 'outgoing' || direction === 'both') {
        const outgoing = queries.getOutgoingEdges(nodeId);
        for (const edge of outgoing) {
            if (edgeKinds && !edgeKinds.has(edge.kind))
                continue;
            neighbors.push({
                edge,
                neighborId: edge.target,
                fromNodeId: nodeId,
                traversalDirection: 'outgoing',
            });
        }
    }
    if (direction === 'incoming' || direction === 'both') {
        const incoming = queries.getIncomingEdges(nodeId);
        for (const edge of incoming) {
            if (edgeKinds && !edgeKinds.has(edge.kind))
                continue;
            neighbors.push({
                edge,
                neighborId: edge.source,
                fromNodeId: nodeId,
                traversalDirection: 'incoming',
            });
        }
    }
    return neighbors;
}
/** 批量获取多个节点的邻居 — 整层 frontier 一次 SQL 查询 */
function getNeighborsBatch(queries, nodeIds, direction, edgeKinds) {
    const neighbors = [];
    if (direction === 'outgoing' || direction === 'both') {
        const outgoingMap = queries.getOutgoingEdgesBatch(nodeIds);
        outgoingMap.forEach((edges, fromNodeId) => {
            for (const edge of edges) {
                if (edgeKinds && !edgeKinds.has(edge.kind))
                    continue;
                neighbors.push({
                    edge,
                    neighborId: edge.target,
                    fromNodeId,
                    traversalDirection: 'outgoing',
                });
            }
        });
    }
    if (direction === 'incoming' || direction === 'both') {
        const incomingMap = queries.getIncomingEdgesBatch(nodeIds);
        incomingMap.forEach((edges, fromNodeId) => {
            for (const edge of edges) {
                if (edgeKinds && !edgeKinds.has(edge.kind))
                    continue;
                neighbors.push({
                    edge,
                    neighborId: edge.source,
                    fromNodeId,
                    traversalDirection: 'incoming',
                });
            }
        });
    }
    return neighbors;
}
function edgeIdentity(edge) {
    return edge.id !== undefined
        ? `id:${edge.id}`
        : `${edge.source}\0${edge.target}\0${edge.kind}\0${edge.originRefKey ?? ''}\0${edge.line ?? ''}\0${edge.column ?? ''}`;
}
function compareEdges(left, right) {
    return compareBytes(left.source, right.source)
        || compareBytes(left.target, right.target)
        || compareBytes(left.kind, right.kind)
        || compareBytes(left.originRefKey ?? '', right.originRefKey ?? '')
        || (left.id ?? 0) - (right.id ?? 0);
}
function compareBytes(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function normalizeNodeLimit(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}
function normalizeOptionalNodeLimit(value) {
    return value === undefined ? null : normalizeNodeLimit(value, 1_000);
}
function normalizePublicDepth(value, fallback) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.max(0, Math.trunc(parsed));
}
//# sourceMappingURL=traversal.js.map