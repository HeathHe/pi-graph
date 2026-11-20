// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
export function truncate(text, maxLen) {
    if (!text)
        return '';
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen - 3) + '...';
}
export function countBy(items, keyFn) {
    const counts = {};
    for (const item of items) {
        const key = keyFn(item);
        counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
}
// ---------------------------------------------------------------------------
// searchNodes — filter nodes by name, summary, or tags
// ---------------------------------------------------------------------------
export function searchNodes(graph, query, opts) {
    const needle = query.toLowerCase();
    const limit = opts?.limit ?? 10;
    let matches = graph.nodes.filter(n => {
        const haystack = [
            n.name,
            n.summary,
            ...(n.tags ?? []),
        ].join(' ').toLowerCase();
        return haystack.includes(needle);
    });
    if (opts?.type) {
        const typeFilter = opts.type.toLowerCase();
        matches = matches.filter(n => n.type.toLowerCase() === typeFilter);
    }
    return matches.slice(0, limit);
}
// ---------------------------------------------------------------------------
// findPath — BFS shortest path between two nodes (undirected)
// ---------------------------------------------------------------------------
export function findPath(graph, fromId, toId) {
    const fromNode = graph.nodes.find(n => n.id === fromId);
    const toNode = graph.nodes.find(n => n.id === toId);
    if (!fromNode) {
        throw new Error(`Source node not found: ${fromId}`);
    }
    if (!toNode) {
        throw new Error(`Target node not found: ${toId}`);
    }
    // Build adjacency list (undirected)
    const adj = new Map();
    for (const e of graph.edges) {
        if (!adj.has(e.source))
            adj.set(e.source, []);
        if (!adj.has(e.target))
            adj.set(e.target, []);
        adj.get(e.source).push({ neighbor: e.target, edge: e });
        adj.get(e.target).push({ neighbor: e.source, edge: e });
    }
    // BFS
    const visited = new Set();
    const parent = new Map();
    const queue = [fromId];
    visited.add(fromId);
    let found = false;
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === toId) {
            found = true;
            break;
        }
        for (const { neighbor, edge } of adj.get(current) ?? []) {
            if (!visited.has(neighbor)) {
                visited.add(neighbor);
                parent.set(neighbor, { node: current, edge });
                queue.push(neighbor);
            }
        }
    }
    if (!found) {
        return { from: fromId, to: toId, found: false, length: 0, steps: [] };
    }
    // Reconstruct path
    const pathNodes = [];
    const pathEdges = [];
    let cur = toId;
    while (cur !== fromId) {
        pathNodes.unshift(cur);
        const p = parent.get(cur);
        pathEdges.unshift(p.edge);
        cur = p.node;
    }
    pathNodes.unshift(fromId);
    const steps = pathNodes.map((nid, i) => {
        const n = graph.nodes.find(nd => nd.id === nid);
        return {
            node: nid,
            type: n?.type,
            name: n?.name,
            edgeToNext: i < pathEdges.length ? pathEdges[i].type : undefined,
        };
    });
    return { from: fromId, to: toId, found: true, length: pathEdges.length, steps };
}
// ---------------------------------------------------------------------------
// diffChanges — find direct + 1-hop impacted nodes from changed files
// ---------------------------------------------------------------------------
export function diffChanges(graph, changedFiles) {
    // Find direct nodes (filePath matches a changed file)
    const direct = graph.nodes.filter(n => n.filePath && changedFiles.some(f => n.filePath === f || n.filePath.endsWith('/' + f) || f.endsWith('/' + n.filePath)));
    const directIds = new Set(direct.map(n => n.id));
    // Expand 1 hop: find all directly connected nodes
    const impactedIds = new Set();
    for (const e of graph.edges) {
        if (directIds.has(e.source) && !directIds.has(e.target)) {
            impactedIds.add(e.target);
        }
        if (directIds.has(e.target) && !directIds.has(e.source)) {
            impactedIds.add(e.source);
        }
    }
    const impacted = graph.nodes.filter(n => impactedIds.has(n.id));
    return { changedFiles, direct, impacted };
}
//# sourceMappingURL=query.js.map