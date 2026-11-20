function rowToNode(row) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        qualifiedName: row.qualified_name ?? '',
        filePath: row.file_path ?? '',
        language: (row.language ?? 'unknown'),
        startLine: row.start_line ?? 0,
        endLine: row.end_line ?? 0,
        startColumn: row.start_column ?? 0,
        endColumn: row.end_column ?? 0,
        docstring: row.docstring ?? '',
        signature: row.signature ?? '',
        visibility: (row.visibility ?? ''),
        isExported: row.is_exported === 1,
        isAsync: row.is_async === 1,
        isStatic: row.is_static === 1,
        isAbstract: row.is_abstract === 1,
        decorators: row.decorators ? JSON.parse(row.decorators) : [],
        typeParameters: row.type_parameters ? JSON.parse(row.type_parameters) : [],
        updatedAt: row.updated_at,
    };
}
function rowToEdge(row) {
    return {
        id: row.id,
        source: row.source,
        target: row.target,
        kind: row.kind,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
        line: row.line ?? undefined,
        column: row.col ?? undefined,
        provenance: row.provenance ?? undefined,
    };
}
function rowToFile(row) {
    return {
        path: row.path,
        contentHash: row.content_hash ?? '',
        language: (row.language ?? 'unknown'),
        size: row.size ?? 0,
        modifiedAt: row.modified_at ?? '',
        indexedAt: row.indexed_at,
        nodeCount: row.node_count,
        errors: row.errors ? JSON.parse(row.errors) : [],
    };
}
// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------
export class QueryBuilder {
    conn;
    stmtCache = new Map();
    constructor(conn) {
        this.conn = conn;
    }
    stmt(sql) {
        let s = this.stmtCache.get(sql);
        if (!s) {
            s = this.conn.raw.prepare(sql);
            this.stmtCache.set(sql, s);
        }
        return s;
    }
    // ── Node CRUD ──────────────────────────────────────────────────────
    getNodeById(id) {
        const row = this.stmt('SELECT * FROM nodes WHERE id = ?').get(id);
        return row ? rowToNode(row) : null;
    }
    getNodesByIds(ids) {
        const result = new Map();
        if (ids.length === 0)
            return result;
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.conn.raw.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...ids);
        for (const row of rows) {
            result.set(row.id, rowToNode(row));
        }
        return result;
    }
    getNodesByFile(filePath) {
        const rows = this.stmt('SELECT * FROM nodes WHERE file_path = ?').all(filePath);
        return rows.map(rowToNode);
    }
    getNodesByKind(kind) {
        const rows = this.stmt('SELECT * FROM nodes WHERE kind = ?').all(kind);
        return rows.map(rowToNode);
    }
    insertNode(node) {
        this.stmt(`
      INSERT OR REPLACE INTO nodes
        (id, kind, name, qualified_name, file_path, language,
         start_line, end_line, start_column, end_column,
         docstring, signature, visibility, is_exported, is_async,
         is_static, is_abstract, decorators, type_parameters, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(node.id, node.kind, node.name, node.qualifiedName || null, node.filePath || null, node.language || null, node.startLine || null, node.endLine || null, node.startColumn || null, node.endColumn || null, node.docstring || null, node.signature || null, node.visibility || null, node.isExported ? 1 : 0, node.isAsync ? 1 : 0, node.isStatic ? 1 : 0, node.isAbstract ? 1 : 0, node.decorators.length > 0 ? JSON.stringify(node.decorators) : null, node.typeParameters.length > 0 ? JSON.stringify(node.typeParameters) : null);
    }
    insertNodes(nodes) {
        for (const node of nodes) {
            this.insertNode(node);
        }
    }
    deleteNode(id) {
        this.stmt('DELETE FROM nodes WHERE id = ?').run(id);
    }
    deleteNodesByFile(filePath) {
        this.stmt('DELETE FROM nodes WHERE file_path = ?').run(filePath);
    }
    // ── Edge CRUD ──────────────────────────────────────────────────────
    getOutgoingEdges(nodeId, kinds) {
        if (kinds && kinds.length > 0) {
            const placeholders = kinds.map(() => '?').join(',');
            return this.conn.raw.prepare(`SELECT * FROM edges WHERE source = ? AND kind IN (${placeholders})`).all(nodeId, ...kinds).map(rowToEdge);
        }
        return this.stmt('SELECT * FROM edges WHERE source = ?')
            .all(nodeId).map(rowToEdge);
    }
    getIncomingEdges(nodeId, kinds) {
        if (kinds && kinds.length > 0) {
            const placeholders = kinds.map(() => '?').join(',');
            return this.conn.raw.prepare(`SELECT * FROM edges WHERE target = ? AND kind IN (${placeholders})`).all(nodeId, ...kinds).map(rowToEdge);
        }
        return this.stmt('SELECT * FROM edges WHERE target = ?')
            .all(nodeId).map(rowToEdge);
    }
    insertEdge(edge) {
        this.stmt(`
      INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(edge.source, edge.target, edge.kind, edge.metadata ? JSON.stringify(edge.metadata) : null, edge.line ?? null, edge.column ?? null, edge.provenance ?? null);
    }
    insertEdges(edges) {
        for (const edge of edges) {
            this.insertEdge(edge);
        }
    }
    deleteEdgesFrom(source) {
        this.stmt('DELETE FROM edges WHERE source = ?').run(source);
    }
    deleteEdgesForFile(filePath) {
        this.conn.raw.prepare(`DELETE FROM edges WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
        OR target IN (SELECT id FROM nodes WHERE file_path = ?)`).run(filePath, filePath);
    }
    // ── File CRUD ──────────────────────────────────────────────────────
    getFile(path) {
        const row = this.stmt('SELECT * FROM files WHERE path = ?').get(path);
        return row ? rowToFile(row) : null;
    }
    getAllFiles() {
        return this.stmt('SELECT * FROM files').all().map(rowToFile);
    }
    upsertFile(file) {
        this.stmt(`
      INSERT OR REPLACE INTO files
        (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, datetime('now'), ?, ?)
    `).run(file.path, file.contentHash, file.language, file.size, file.modifiedAt, file.nodeCount, file.errors.length > 0 ? JSON.stringify(file.errors) : null);
    }
    deleteFile(path) {
        this.stmt('DELETE FROM files WHERE path = ?').run(path);
    }
    getStaleFiles(currentHashes) {
        const existing = new Map();
        for (const file of this.getAllFiles()) {
            existing.set(file.path, file.contentHash);
        }
        const added = [];
        const modified = [];
        for (const [path, hash] of currentHashes) {
            const old = existing.get(path);
            if (!old)
                added.push(path);
            else if (old !== hash)
                modified.push(path);
        }
        const deleted = [];
        for (const path of existing.keys()) {
            if (!currentHashes.has(path))
                deleted.push(path);
        }
        return { added, modified, deleted };
    }
    // ── Unresolved Refs ────────────────────────────────────────────────
    insertUnresolvedRef(ref) {
        this.stmt(`
      INSERT INTO unresolved_refs
        (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.column, ref.candidates.length > 0 ? JSON.stringify(ref.candidates) : null, ref.filePath, ref.language);
    }
    deleteUnresolvedRefsForFile(filePath) {
        this.stmt('DELETE FROM unresolved_refs WHERE file_path = ?').run(filePath);
    }
    getUnresolvedReferencesCount() {
        const row = this.stmt('SELECT COUNT(*) as c FROM unresolved_refs').get();
        return row.c;
    }
    // ── Search ─────────────────────────────────────────────────────────
    searchNodes(query, options) {
        const requestedLimit = options?.limit ?? 20;
        const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 20, 500));
        const conditions = [];
        const params = [];
        if (options?.kinds && options.kinds.length > 0) {
            conditions.push(`kind IN (${options.kinds.map(() => '?').join(',')})`);
            params.push(...options.kinds);
        }
        if (options?.languages && options.languages.length > 0) {
            conditions.push(`language IN (${options.languages.map(() => '?').join(',')})`);
            params.push(...options.languages);
        }
        if (options?.pathFilters) {
            for (const pf of options.pathFilters) {
                conditions.push('LOWER(file_path) LIKE ?');
                params.push(`%${pf.toLowerCase()}%`);
            }
        }
        if (options?.nameFilters) {
            for (const nf of options.nameFilters) {
                conditions.push('LOWER(name) LIKE ?');
                params.push(`%${nf.toLowerCase()}%`);
            }
        }
        if (query && query.trim()) {
            const ftsQuery = query.trim().split(/\s+/).map(t => `"${t}"*`).join(' OR ');
            const whereClause = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
            const sql = `
        SELECT nodes.* FROM nodes_fts
        JOIN nodes ON nodes.id = nodes_fts.id
        WHERE nodes_fts MATCH ? ${whereClause}
        ORDER BY rank
        LIMIT ?
      `;
            try {
                const rows = this.conn.raw.prepare(sql).all(ftsQuery, ...params, limit);
                if (rows.length > 0)
                    return rows.map(rowToNode);
            }
            catch {
                // FTS5 match failure — fall through to LIKE
            }
            // LIKE fallback
            const likeWhere = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';
            const likeSql = `
        SELECT * FROM nodes
        WHERE (LOWER(name) LIKE ? OR LOWER(qualified_name) LIKE ? OR LOWER(signature) LIKE ?)
        ${likeWhere}
        LIMIT ?
      `;
            const pattern = `%${query.toLowerCase()}%`;
            const likeRows = this.conn.raw.prepare(likeSql).all(pattern, pattern, pattern, ...params, limit);
            return likeRows.map(rowToNode);
        }
        // No text query — just filters
        if (conditions.length === 0) {
            return this.stmt('SELECT * FROM nodes LIMIT ?').all(limit).map(rowToNode);
        }
        const sql = `SELECT * FROM nodes WHERE ${conditions.join(' AND ')} LIMIT ?`;
        return this.conn.raw.prepare(sql).all(...params, limit).map(rowToNode);
    }
    // ── Statistics ─────────────────────────────────────────────────────
    getStats(dbSizeBytes) {
        const nodeCount = this.stmt('SELECT COUNT(*) as c FROM nodes').get().c;
        const edgeCount = this.stmt('SELECT COUNT(*) as c FROM edges').get().c;
        const fileCount = this.stmt('SELECT COUNT(*) as c FROM files').get().c;
        const unresolvedRefCount = this.getUnresolvedReferencesCount();
        const nodesByKind = {};
        for (const row of this.stmt('SELECT kind, COUNT(*) as c FROM nodes GROUP BY kind').all()) {
            nodesByKind[row.kind] = row.c;
        }
        const edgesByKind = {};
        for (const row of this.stmt('SELECT kind, COUNT(*) as c FROM edges GROUP BY kind').all()) {
            edgesByKind[row.kind] = row.c;
        }
        const nodesByLanguage = {};
        for (const row of this.stmt('SELECT language, COUNT(*) as c FROM nodes WHERE language IS NOT NULL GROUP BY language').all()) {
            nodesByLanguage[row.language] = row.c;
        }
        return {
            nodeCount, edgeCount, fileCount, unresolvedRefCount,
            nodesByKind, edgesByKind, nodesByLanguage,
            dbSizeBytes: dbSizeBytes ?? 0,
        };
    }
    getNodeAndEdgeCount() {
        const nodes = this.stmt('SELECT COUNT(*) as c FROM nodes').get().c;
        const edges = this.stmt('SELECT COUNT(*) as c FROM edges').get().c;
        return { nodes, edges };
    }
    // ── Project Metadata ───────────────────────────────────────────────
    setMetadata(key, value) {
        this.stmt('INSERT OR REPLACE INTO project_metadata (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run(key, value);
    }
    getMetadata(key) {
        const row = this.stmt('SELECT value FROM project_metadata WHERE key = ?').get(key);
        return row?.value ?? null;
    }
    // ── Bulk Operations ────────────────────────────────────────────────
    clear() {
        this.conn.raw.exec('DELETE FROM edges');
        this.conn.raw.exec('DELETE FROM unresolved_refs');
        this.conn.raw.exec('DELETE FROM nodes');
        this.conn.raw.exec('DELETE FROM files');
    }
}
//# sourceMappingURL=queries.js.map