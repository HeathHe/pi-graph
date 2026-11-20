import { existsSync } from 'node:fs';
import { loadGraph } from './loader.js';
import { searchNodes as searchNodesJson, findPath as findPathJson, diffChanges as diffChangesJson } from './query.js';
import { DatabaseConnection, getDatabasePath } from './db/connection.js';
import { QueryBuilder } from './db/queries.js';
import { GraphTraverser } from './traversal.js';
import { GraphQueryManager } from './graph-queries.js';
import { IncrementalSync } from './sync/incremental-sync.js';
import { parseQuery } from './search/query-parser.js';
export function detectBackend(projectRoot) {
    const dbPath = getDatabasePath(projectRoot);
    if (existsSync(dbPath))
        return 'sqlite';
    try {
        loadGraph();
        return 'json';
    }
    catch {
        return 'none';
    }
}
export class GraphFacade {
    backend;
    conn = null;
    queries = null;
    manager = null;
    traverser = null;
    jsonGraph = null;
    constructor(projectRoot) {
        this.backend = detectBackend(projectRoot);
        if (this.backend === 'sqlite') {
            this.conn = new DatabaseConnection();
            this.conn.open(getDatabasePath(projectRoot));
            this.queries = new QueryBuilder(this.conn);
            this.manager = new GraphQueryManager(this.queries);
            this.traverser = new GraphTraverser(this.queries);
        }
        else if (this.backend === 'json') {
            this.jsonGraph = loadGraph();
        }
    }
    getBackend() {
        return this.backend;
    }
    close() {
        this.conn?.close();
        this.conn = null;
    }
    search(query, opts) {
        if (this.backend === 'sqlite' && this.queries) {
            const parsed = parseQuery(query);
            const nodes = this.queries.searchNodes(parsed.text || query, {
                kinds: parsed.kinds.length > 0 ? parsed.kinds : undefined,
                languages: parsed.languages.length > 0 ? parsed.languages : undefined,
                pathFilters: parsed.pathFilters.length > 0 ? parsed.pathFilters : undefined,
                nameFilters: parsed.nameFilters.length > 0 ? parsed.nameFilters : undefined,
                limit: opts?.limit ?? 10,
            });
            return nodes.map(n => ({
                id: n.id, kind: n.kind, name: n.name, filePath: n.filePath,
                summary: n.signature || n.docstring,
            }));
        }
        if (this.jsonGraph) {
            const results = searchNodesJson(this.jsonGraph, query, { limit: opts?.limit, type: opts?.type });
            return results.map(n => ({
                id: n.id, kind: n.type, name: n.name, filePath: n.filePath,
                summary: n.summary,
            }));
        }
        return [];
    }
    findPath(fromId, toId) {
        if (this.jsonGraph) {
            const result = findPathJson(this.jsonGraph, fromId, toId);
            return result.found ? result : null;
        }
        if (this.traverser) {
            const path = this.traverser.findPath(fromId, toId);
            if (!path)
                return null;
            return {
                from: fromId,
                to: toId,
                found: true,
                length: path.length - 1,
                steps: path.map((step, i) => ({
                    node: step.node.id,
                    type: step.node.kind,
                    name: step.node.name,
                    edgeToNext: i < path.length - 1 ? path[i + 1]?.edge?.kind : undefined,
                })),
            };
        }
        return null;
    }
    diffChanges(changedFiles) {
        if (this.jsonGraph)
            return diffChangesJson(this.jsonGraph, changedFiles);
        if (this.queries && this.traverser) {
            const direct = [];
            const impactedIds = new Set();
            for (const file of changedFiles) {
                const nodes = this.queries.getNodesByFile(file);
                for (const n of nodes) {
                    direct.push({ id: n.id, type: n.kind, name: n.name, filePath: n.filePath, summary: n.signature || n.docstring, tags: [n.kind] });
                    const impact = this.traverser.getImpactRadius(n.id, 1);
                    for (const impacted of impact.nodes.values()) {
                        if (!direct.some(d => d.id === impacted.id))
                            impactedIds.add(impacted.id);
                    }
                }
            }
            const impacted = [];
            if (impactedIds.size > 0) {
                const impactedNodes = this.queries.getNodesByIds([...impactedIds]);
                for (const n of impactedNodes.values()) {
                    impacted.push({ id: n.id, type: n.kind, name: n.name, filePath: n.filePath, summary: n.signature || n.docstring, tags: [n.kind] });
                }
            }
            return { changedFiles, direct, impacted };
        }
        return { changedFiles, direct: [], impacted: [] };
    }
    stats() {
        if (this.queries && this.conn) {
            return this.queries.getStats(this.conn.getSize());
        }
        return null;
    }
    // SQLite-only methods
    getCallers(nodeId, depth) {
        this.requireSqlite('getCallers');
        return this.traverser.getCallers(nodeId, depth ?? 2);
    }
    getCallees(nodeId, depth) {
        this.requireSqlite('getCallees');
        return this.traverser.getCallees(nodeId, depth ?? 2);
    }
    getImpactRadius(nodeId, depth) {
        this.requireSqlite('getImpactRadius');
        return this.traverser.getImpactRadius(nodeId, depth ?? 3);
    }
    findDeadCode(kinds) {
        this.requireSqlite('findDeadCode');
        return this.manager.findDeadCode(kinds);
    }
    findCircularDependencies() {
        this.requireSqlite('findCircularDependencies');
        return this.manager.findCircularDependencies();
    }
    getContext(nodeId) {
        this.requireSqlite('getContext');
        return this.manager.getContext(nodeId);
    }
    getNodeMetrics(nodeId) {
        this.requireSqlite('getNodeMetrics');
        return this.manager.getNodeMetrics(nodeId);
    }
    sync() {
        this.requireSqlite('sync');
        const sync = new IncrementalSync(process.cwd(), this.conn);
        const result = sync.sync();
        return { filesChanged: result.filesChanged, durationMs: result.durationMs };
    }
    requireSqlite(method) {
        if (this.backend !== 'sqlite') {
            throw new Error(`${method}() requires SQLite backend. Run "maestro kg index --sqlite" first.`);
        }
    }
}
//# sourceMappingURL=facade.js.map