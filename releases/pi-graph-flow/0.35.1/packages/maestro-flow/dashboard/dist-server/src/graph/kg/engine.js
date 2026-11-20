// src/graph/kg/engine.ts — MaestroGraph 主入口类
// 参考: plan-maestrograph.md Gap C8 — CodeGraph Public Lifecycle API
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { KgDatabaseConnection, KgQueryBuilder, KG_SCHEMA_VERSION, getKgDatabasePath, applyMigrations, } from './db/index.js';
import { resolveKnowledgeEdges as resolveKnowledgeEdgesImpl } from './resolution/knowledge-resolver.js';
import { resolveCodeStructuralReferences as resolveCodeStructuralReferencesImpl } from './resolution/code-reference-resolver.js';
import { bfs, dfs as dfsImpl, getCallers as getCallersImpl, getCallees as getCalleesImpl, getImpactRadius, getCallGraph as getCallGraphImpl, getTypeHierarchy as getTypeHierarchyImpl, findUsages as findUsagesImpl, getAncestors as getAncestorsImpl, getChildren as getChildrenImpl, getNodeContext as getNodeContextImpl, getFileDependencies as getFileDependenciesImpl, getFileDependents as getFileDependentsImpl, findDeadCode as findDeadCodeImpl, getNodeMetrics as getNodeMetricsImpl, findShortestPath as findShortestPathImpl, findShortestPathResult as findShortestPathResultImpl, } from './query/traversal.js';
import { searchUnified as searchUnifiedImpl, mergeCodeSearchResults } from './query/search.js';
import { buildCodeEmbeddingIndex, saveCodeEmbeddingIndex } from './embedding/index.js';
import { buildContext as buildContextImpl } from './query/context-builder.js';
import { prepareExternalSurfaceScan } from './extraction/code/external/external-surface-manifest.js';
import { getGitHead, getSyncStateHealth, isSyncStateFresh } from './sync-state.js';
export function makeNodeResolutionErrorPayload(resolution) {
    return {
        code: resolution.status === 'ambiguous' ? 'ambiguous_node' : 'node_not_found',
        query: resolution.query,
        strategy: resolution.strategy,
        candidates: resolution.candidates.map(node => node.id),
    };
}
export class MaestroGraph {
    conn = null;
    queries = null;
    projectRoot;
    _codeEmbeddingCache = null;
    constructor(projectRoot) {
        this.projectRoot = resolve(projectRoot);
    }
    // ── Lifecycle ──────────────────────────────────────────────────────
    static async init(projectRoot) {
        const mg = new MaestroGraph(projectRoot);
        const dbPath = getKgDatabasePath(projectRoot);
        mg.conn = new KgDatabaseConnection();
        try {
            mg.conn.initialize(dbPath);
            applyMigrations(mg.conn);
            mg.queries = new KgQueryBuilder(mg.conn);
            return mg;
        }
        catch (error) {
            // initialize() has already created the DB file (and may have committed
            // the v2 schema stamp) before applyMigrations threw. A half-created
            // maestro.db would make isInitialized() return true via existsSync,
            // permanently blocking future auto-init. Clean it up so the next attempt
            // starts fresh, and close the leaked connection first.
            mg.close();
            await removePartialDatabase(dbPath);
            throw error;
        }
    }
    static async open(projectRoot) {
        const mg = new MaestroGraph(projectRoot);
        const dbPath = getKgDatabasePath(projectRoot);
        if (!existsSync(dbPath)) {
            throw new Error(`MaestroGraph not initialized. Run "maestro kg init" first. Expected: ${dbPath}`);
        }
        mg.conn = new KgDatabaseConnection();
        try {
            mg.conn.open(dbPath);
            applyMigrations(mg.conn);
            mg.queries = new KgQueryBuilder(mg.conn);
            return mg;
        }
        catch (error) {
            // DatabaseSync keeps the file locked on Windows even when opening or
            // migrating fails. Close the partially opened connection so workers can
            // delete a broken fixture/database and retry deterministically.
            try {
                mg.close();
            }
            catch (closeError) {
                throw new AggregateError([error, closeError], 'MaestroGraph open failed and its database handle could not be closed');
            }
            throw error;
        }
    }
    /**
     * 以隔离只读方式打开现有 canonical MaestroGraph 数据库。
     * 此路径显式跳过 migration、sync 与 embedding lifecycle。
     */
    static async openReadOnly(projectRoot) {
        const mg = new MaestroGraph(projectRoot);
        const dbPath = getKgDatabasePath(projectRoot);
        if (!existsSync(dbPath)) {
            throw new Error(`MaestroGraph not initialized. Expected: ${dbPath}`);
        }
        mg.conn = new KgDatabaseConnection();
        mg.conn.openReadOnly(dbPath);
        mg.queries = new KgQueryBuilder(mg.conn);
        return mg;
    }
    static isInitialized(projectRoot) {
        return existsSync(getKgDatabasePath(projectRoot));
    }
    static openSync(projectRoot) {
        const dbPath = getKgDatabasePath(resolve(projectRoot));
        if (!existsSync(dbPath))
            return null;
        // DB exists but may be corrupt/unmigratable. Distinguish that from a simple
        // 'not initialized' so callers do not silently degrade on a corrupt file.
        try {
            const mg = new MaestroGraph(projectRoot);
            mg.conn = new KgDatabaseConnection();
            mg.conn.open(dbPath);
            try {
                applyMigrations(mg.conn);
            }
            catch (migrationError) {
                // A migration failure leaves the DB partially migrated or FTS-corrupt;
                // querying it would surface cryptic SQLite errors far from the cause.
                // Close the connection and surface the failure as null (not-initialized)
                // so callers fall back instead of operating on a broken graph.
                mg.close();
                process.stderr.write(`[MaestroGraph] openSync migration failed, graph unavailable: ${migrationError instanceof Error ? migrationError.message : String(migrationError)}\n`);
                return null;
            }
            mg.queries = new KgQueryBuilder(mg.conn);
            return mg;
        }
        catch (error) {
            process.stderr.write(`[MaestroGraph] openSync failed: ${error instanceof Error ? error.message : String(error)}\n`);
            return null;
        }
    }
    get rawDb() {
        if (!this.conn)
            throw new Error('MaestroGraph not open');
        return this.conn.raw;
    }
    close() {
        this.conn?.close();
        this.conn = null;
        this.queries = null;
        this._codeEmbeddingCache = null;
    }
    // ── Indexing ──────────────────────────────────────────────────────
    async indexAll(options) {
        const { syncKnowledgeGraph } = await import('./extraction/orchestrator.js');
        return syncKnowledgeGraph(this.projectRoot, { sources: options?.sources, graph: this });
    }
    async indexKnowledge(options) {
        const knowledgeSources = options?.sources
            ?? ['domain', 'spec', 'knowhow', 'codebase', 'issue'];
        const { syncKnowledgeGraph } = await import('./extraction/orchestrator.js');
        return syncKnowledgeGraph(this.projectRoot, { sources: knowledgeSources, graph: this });
    }
    async sync() {
        const { syncKnowledgeGraph } = await import('./extraction/orchestrator.js');
        return syncKnowledgeGraph(this.projectRoot, { graph: this });
    }
    resolveReferences() {
        if (!this.conn)
            throw new Error('MaestroGraph not open');
        const startedAt = Date.now();
        const code = this.resolveCodeStructuralReferences();
        const knowledge = this.resolveKnowledgeEdges();
        return {
            edgesCreated: code.edgesCreated + knowledge.totalEdgesCreated,
            codeStructuralEdgesCreated: code.edgesCreated,
            knowledgeEdgesCreated: knowledge.totalEdgesCreated,
            edges: [...code.edges, ...knowledge.edges],
            durationMs: Date.now() - startedAt,
        };
    }
    resolveCodeStructuralReferences() {
        if (!this.conn || !this.queries)
            throw new Error('MaestroGraph not open');
        return this.conn.transaction(() => (resolveCodeStructuralReferencesImpl(this.queries)));
    }
    resolveKnowledgeEdges() {
        if (!this.conn)
            throw new Error('MaestroGraph not open');
        return resolveKnowledgeEdgesImpl(this.conn.raw, { projectPath: this.projectRoot });
    }
    // ── Query ─────────────────────────────────────────────────────────
    searchUnified(query, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return searchUnifiedImpl(this.queries, query, {
            sourceTypes: options?.sourceTypes,
            kinds: options?.kinds,
            limit: options?.limit ?? 20,
            includeCode: options?.includeCode,
            includeKnowledge: options?.includeKnowledge,
        });
    }
    searchCode(query, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return this.queries.searchCodeFTS(query, {
            kinds: options?.kinds,
            languages: options?.languages,
            limit: options?.limit ?? 20,
        });
    }
    searchKnowledge(query, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return this.queries.searchKnowledgeFTS(query, {
            sourceTypes: options?.sourceTypes,
            limit: options?.limit ?? 20,
        });
    }
    // ── Code Embedding ────────────────────────────────────────────────
    _getCodeEmbeddingDir() {
        return resolve(this.projectRoot, '.workflow', 'kg');
    }
    /**
     * Build (or incrementally rebuild) the code embedding index from all codegraph nodes.
     * Persists the index to .workflow/kg/code-embedding-index.bin and caches in memory.
     */
    async buildCodeEmbeddings() {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        // Get all code nodes from the DB (only codegraph nodes are embeddable)
        const allCodeNodes = this.queries.getNodesBySourceType('codegraph');
        // Build index (incremental if cache exists)
        const index = await buildCodeEmbeddingIndex(allCodeNodes, this._codeEmbeddingCache);
        // Persist to disk
        const dir = this._getCodeEmbeddingDir();
        saveCodeEmbeddingIndex(index, dir);
        // Cache in memory
        this._codeEmbeddingCache = index;
        return index;
    }
    /**
     * Load the code embedding index from disk or return the in-memory cache.
     * Returns null if no persisted index exists.
     */
    async getCodeEmbeddingIndex() {
        if (this._codeEmbeddingCache)
            return this._codeEmbeddingCache;
        try {
            const { loadCodeEmbeddingIndex } = await import('./embedding/index.js');
            const dir = this._getCodeEmbeddingDir();
            const index = loadCodeEmbeddingIndex(dir);
            if (index) {
                const { getModelId } = await import('#maestro-dashboard/wiki/embedding.js');
                if (index.modelId !== getModelId())
                    return null;
                this._codeEmbeddingCache = index;
            }
            return index;
        }
        catch {
            return null;
        }
    }
    async searchHybrid(query, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        const limit = options?.limit ?? 20;
        const vecPromise = this._getVectorResults(query, limit * 2);
        const ftsOutput = searchUnifiedImpl(this.queries, query, {
            limit: limit * 2,
            sourceTypes: options?.sourceTypes,
        });
        const vecResults = await vecPromise;
        if (!vecResults || vecResults.length === 0) {
            return ftsOutput.directMatches.slice(0, limit);
        }
        return mergeCodeSearchResults(ftsOutput.directMatches, vecResults, this.queries, limit);
    }
    async _getVectorResults(query, limit) {
        const embIdx = await this.getCodeEmbeddingIndex();
        if (!embIdx || embIdx.nodeIds.length === 0)
            return null;
        const { embedQuery } = await import('#maestro-dashboard/wiki/embedding.js');
        const queryVec = await embedQuery(query);
        if (!queryVec)
            return null;
        const { searchCodeVectors } = await import('./embedding/index.js');
        return searchCodeVectors(queryVec, embIdx, limit);
    }
    getNode(id) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return this.queries.getNode(id);
    }
    /** Resolve only exact identities; ambiguity is data, never a ranking decision. */
    resolveNode(query) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        const direct = this.queries.getNode(query);
        if (direct) {
            return { status: 'resolved', query, strategy: 'id', node: direct, candidates: [direct] };
        }
        const qualified = sortNodesById(this.queries.getNodesByQualifiedName(query));
        if (qualified.length === 1) {
            return {
                status: 'resolved',
                query,
                strategy: 'qualifiedName',
                node: qualified[0],
                candidates: qualified,
            };
        }
        if (qualified.length > 1) {
            return { status: 'ambiguous', query, strategy: 'qualifiedName', candidates: qualified };
        }
        const simple = sortNodesById(this.queries.getNodesByName(query));
        if (simple.length === 1) {
            return {
                status: 'resolved',
                query,
                strategy: 'simpleName',
                node: simple[0],
                candidates: simple,
            };
        }
        if (simple.length > 1) {
            return { status: 'ambiguous', query, strategy: 'simpleName', candidates: simple };
        }
        return { status: 'not_found', query, strategy: 'none', candidates: [] };
    }
    getStats() {
        if (!this.queries || !this.conn)
            throw new Error('MaestroGraph not open');
        return this.queries.getStats(this.conn.getSize());
    }
    getHealth() {
        if (!this.queries || !this.conn)
            throw new Error('MaestroGraph not open');
        const errors = [];
        let schemaVersion = 0;
        try {
            schemaVersion = this.conn.getSchemaVersion();
        }
        catch (error) {
            errors.push(`schema: ${errorMessage(error)}`);
        }
        let integrityMessages = [];
        try {
            const rows = this.conn.raw.prepare('PRAGMA integrity_check').all();
            integrityMessages = rows.map(row => String(Object.values(row)[0] ?? 'unknown'));
        }
        catch (error) {
            errors.push(`integrity: ${errorMessage(error)}`);
        }
        let foreignKeyRows = [];
        try {
            foreignKeyRows = this.conn.raw.prepare('PRAGMA foreign_key_check').all();
        }
        catch (error) {
            errors.push(`foreignKeys: ${errorMessage(error)}`);
        }
        let stats = null;
        let invariants = {
            invalidResolved: 0,
            resolvedWithoutTarget: 0,
            resolvedWithoutOriginEdge: 0,
            invalidOriginEdge: 0,
        };
        try {
            stats = this.getStats();
            invariants = this.queries.getStructuralReferenceInvariantCounts();
        }
        catch (error) {
            errors.push(`stats: ${errorMessage(error)}`);
        }
        let sync = getSyncStateHealth(this.projectRoot);
        if (sync.status === 'fresh') {
            try {
                const external = prepareExternalSurfaceScan(this.projectRoot);
                const currentFreshness = {
                    head: getGitHead(this.projectRoot),
                    manifestDigest: external.manifest.digest,
                    externalFingerprint: external.externalFingerprint,
                };
                if (!isSyncStateFresh(sync.state, currentFreshness)) {
                    sync = { ...sync, status: 'stale', stale: true };
                }
            }
            catch (error) {
                const message = `freshness: ${errorMessage(error)}`;
                errors.push(message);
                sync = { ...sync, status: 'error', stale: true, error: message };
            }
        }
        const structuralStatus = stats?.structuralRefs?.status ?? {};
        const structuralTotal = stats?.structuralRefs?.total ?? 0;
        const resolved = structuralStatus.resolved ?? 0;
        const ambiguous = structuralStatus.ambiguous ?? 0;
        const notFound = structuralStatus.not_found ?? 0;
        const unresolved = Math.max(0, structuralTotal - resolved + invariants.invalidResolved);
        const ratio = (count) => (structuralTotal > 0 ? count / structuralTotal : 0);
        const integrityOk = integrityMessages.length === 1 && integrityMessages[0] === 'ok';
        const foreignKeysOk = foreignKeyRows.length === 0 && !errors.some(error => error.startsWith('foreignKeys:'));
        const failed = errors.length > 0
            || schemaVersion !== KG_SCHEMA_VERSION
            || !integrityOk
            || !foreignKeysOk
            || invariants.invalidResolved > 0
            || sync.status === 'error';
        const warned = sync.stale || unresolved > 0;
        return {
            status: failed ? 'fail' : warned ? 'warn' : 'pass',
            schemaVersion,
            errors,
            integrity: { ok: integrityOk, messages: integrityMessages },
            foreignKeys: {
                ok: foreignKeysOk,
                violations: foreignKeyRows.map(row => ({ ...row })),
            },
            syncState: {
                status: sync.status,
                stale: sync.stale,
                error: sync.error,
                lastSuccessful: sync.state?.lastSuccessful ?? null,
            },
            lastAttempt: sync.state?.lastAttempt ?? null,
            structuralRefs: {
                total: structuralTotal,
                status: structuralStatus,
                unresolved,
                unresolvedRatio: ratio(unresolved),
                ambiguousRatio: ratio(ambiguous),
                notFoundRatio: ratio(notFound),
                invariants,
            },
        };
    }
    getDetectedFrameworks() {
        return this.getStats().detectedFrameworks;
    }
    // ── Traversal (C8 API) ────────────────────────────────────────────
    getCallers(nodeId, depth = 1) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getCallersImpl(this.queries, nodeId, depth);
    }
    getCallees(nodeId, depth = 1) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getCalleesImpl(this.queries, nodeId, depth);
    }
    getImpact(nodeId, depth = 3, direction = 'outgoing') {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getImpactRadius(this.queries, nodeId, depth, direction);
    }
    traverse(startId, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return bfs(this.queries, startId, options);
    }
    traverseDFS(startId, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return dfsImpl(this.queries, startId, options);
    }
    getTypeHierarchy(nodeId, options = {}) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getTypeHierarchyImpl(this.queries, nodeId, options);
    }
    findUsages(nodeId) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return findUsagesImpl(this.queries, nodeId);
    }
    getAncestors(nodeId) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getAncestorsImpl(this.queries, nodeId);
    }
    getChildren(nodeId) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getChildrenImpl(this.queries, nodeId);
    }
    getCallGraph(nodeId, depth) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getCallGraphImpl(this.queries, nodeId, depth);
    }
    getNodeContext(nodeId) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getNodeContextImpl(this.queries, nodeId);
    }
    getFileDependencies(filePath) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getFileDependenciesImpl(this.queries, filePath);
    }
    getFileDependents(filePath) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getFileDependentsImpl(this.queries, filePath);
    }
    findDeadCode(options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return findDeadCodeImpl(this.queries, options);
    }
    getNodeMetrics(nodeId) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return getNodeMetricsImpl(this.queries, nodeId);
    }
    findShortestPath(fromId, toId, maxDepth) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return findShortestPathImpl(this.queries, fromId, toId, maxDepth);
    }
    findShortestPathResult(fromId, toId, maxDepth, maxNodes) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return findShortestPathResultImpl(this.queries, fromId, toId, maxDepth, maxNodes);
    }
    // ── Context (C8 API) ──────────────────────────────────────────────
    buildContext(query, options) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return buildContextImpl(this.queries, query, options);
    }
    // ── Internal Access (供 CLI/MCP 消费) ──────────────────────────────
    getQueryBuilder() {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        return this.queries;
    }
    getConnection() {
        if (!this.conn)
            throw new Error('MaestroGraph not open');
        return this.conn;
    }
    // ── Insertion (供 extractor 使用) ──────────────────────────────────
    insertExtractionResults(result) {
        if (!this.queries)
            throw new Error('MaestroGraph not open');
        this.conn.transaction(() => {
            this.queries.deleteUnresolvedRefsByFile(result.fileRecord.path);
            this.queries.deleteStructuralReferencesByOriginFile(result.fileRecord.path);
            this.queries.insertNodes(result.nodes);
            this.queries.insertEdges(result.edges);
            for (const reference of result.references ?? []) {
                this.queries.insertUnresolvedRef({
                    fromNodeId: reference.fromSymbolId,
                    referenceName: reference.referenceName,
                    referenceKind: reference.referenceKind,
                    line: reference.line,
                    col: reference.col,
                    filePath: reference.filePath,
                    language: reference.language,
                });
            }
            this.queries.stageStructuralReferences(result.structuralReferences ?? []);
            this.queries.upsertFile(result.fileRecord);
        });
    }
}
function sortNodesById(nodes) {
    return nodes.slice().sort((left, right) => Buffer.from(left.id).compare(Buffer.from(right.id)));
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Remove a partially-created maestro.db and its WAL/SHM sidecars so a failed
 * init does not leave a file that would make isInitialized() return true and
 * permanently block auto-init. Best-effort: missing files are not an error.
 */
async function removePartialDatabase(dbPath) {
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
            await rmSync(path, { force: true });
        }
        catch {
            // Best-effort — a locked or missing file must not mask the original error.
        }
    }
}
//# sourceMappingURL=engine.js.map