// src/graph/kg/db/queries.ts — MaestroGraph 统一 CRUD
// 扩展 CodeGraph QueryBuilder 以支持知识节点 + 双 FTS5
import { tokenize as camelTokenize } from '../resolution/name-matcher.js';
import { compareNodeTie, computeScore, } from '../query/scoring.js';
import { assertStructuralReference, STRUCTURAL_REFERENCE_STATUSES, validateStructuralReferenceStatus, } from '../resolution/structural-reference.js';
function safeJsonParse(str, fallback) {
    if (!str)
        return fallback;
    try {
        return JSON.parse(str);
    }
    catch {
        return fallback;
    }
}
function isRecoverableFtsFailure(err, table) {
    const message = err instanceof Error ? err.message : String(err);
    return new RegExp(`no such table:\\s*${table}`, 'i').test(message)
        || /database disk image is malformed|database corruption|malformed database schema|vtable constructor failed/i.test(message);
}
function isFtsCorruption(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /database disk image is malformed|database corruption|malformed database schema|vtable constructor failed/i.test(message);
}
function clampQueryLimit(value, fallback, max) {
    const candidate = Number.isFinite(value) ? Math.trunc(value) : fallback;
    return Math.max(1, Math.min(candidate, max));
}
function rowToNode(row) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        qualifiedName: row.qualified_name ?? '',
        filePath: row.file_path ?? '',
        language: (row.language ?? 'unknown'),
        startLine: row.start_line,
        endLine: row.end_line,
        startColumn: row.start_column,
        endColumn: row.end_column,
        docstring: row.docstring ?? '',
        signature: row.signature ?? '',
        visibility: (row.visibility ?? ''),
        isExported: Boolean(row.is_exported),
        isAsync: Boolean(row.is_async),
        isStatic: Boolean(row.is_static),
        isAbstract: Boolean(row.is_abstract),
        decorators: safeJsonParse(row.decorators, []),
        typeParameters: safeJsonParse(row.type_parameters, []),
        sourceType: (row.source_type ?? 'codegraph'),
        definition: row.definition ?? '',
        aliases: safeJsonParse(row.aliases, []),
        keywords: safeJsonParse(row.keywords, []),
        category: row.category ?? '',
        roles: safeJsonParse(row.roles, []),
        priority: row.priority ?? '',
        status: row.status ?? 'active',
        body: row.body ?? '',
        metadata: safeJsonParse(row.metadata, {}),
        updatedAt: row.updated_at,
    };
}
function nodeToRow(node) {
    return {
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualified_name: node.qualifiedName,
        file_path: node.filePath,
        language: node.language,
        start_line: node.startLine,
        end_line: node.endLine,
        start_column: node.startColumn,
        end_column: node.endColumn,
        docstring: node.docstring || null,
        signature: node.signature || null,
        visibility: node.visibility || null,
        is_exported: node.isExported ? 1 : 0,
        is_async: node.isAsync ? 1 : 0,
        is_static: node.isStatic ? 1 : 0,
        is_abstract: node.isAbstract ? 1 : 0,
        decorators: node.decorators.length > 0 ? JSON.stringify(node.decorators) : null,
        type_parameters: node.typeParameters.length > 0 ? JSON.stringify(node.typeParameters) : null,
        source_type: node.sourceType,
        definition: node.definition || null,
        aliases: node.aliases.length > 0 ? JSON.stringify(node.aliases) : null,
        keywords: node.keywords.length > 0 ? JSON.stringify(node.keywords) : null,
        category: node.category || null,
        roles: node.roles.length > 0 ? JSON.stringify(node.roles) : null,
        priority: node.priority || null,
        status: node.status || null,
        body: node.body || null,
        metadata: Object.keys(node.metadata).length > 0 ? JSON.stringify(node.metadata) : null,
        updated_at: node.updatedAt,
    };
}
function rowToEdge(row) {
    return {
        id: row.id,
        source: row.source,
        target: row.target,
        kind: row.kind,
        metadata: safeJsonParse(row.metadata, {}),
        line: row.line ?? undefined,
        column: row.col ?? undefined,
        provenance: row.provenance,
        originRefKey: row.origin_ref_key ?? undefined,
    };
}
function rowToStructuralReference(row) {
    return {
        kind: row.ref_kind,
        refKey: row.ref_key,
        anchorNodeId: row.anchor_node_id,
        anchorQualifiedName: row.anchor_qualified_name,
        rawTargetName: row.raw_target_name,
        sourceDeclarationKind: row.source_declaration_kind,
        lookupScope: row.lookup_scope,
        relationHint: row.relation_hint,
        edgeOrientation: row.edge_orientation,
        targetKindHints: safeJsonParse(row.target_kind_hints, []),
        targetLanguageHints: safeJsonParse(row.target_language_hints, []),
        moduleHints: safeJsonParse(row.module_hints, []),
        targetFileHints: safeJsonParse(row.target_file_hints, []),
        origin: {
            filePath: row.origin_file_path,
            language: row.origin_language,
            line: row.origin_line,
            column: row.origin_column,
        },
        compilationCondition: row.compilation_condition ?? undefined,
        evidenceProvenance: row.evidence_provenance,
        resolvedNodeId: row.resolved_node_id,
        status: row.status,
        candidates: safeJsonParse(row.candidates, []),
        resolutionStrategy: row.resolution_strategy,
        confidence: row.confidence,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function edgeToSqlValues(edge) {
    if (edge.originRefKey && edge.provenance && edge.provenance !== 'structural-resolver') {
        throw new Error('origin-bound edges must use structural-resolver provenance');
    }
    return [
        edge.source,
        edge.target,
        edge.kind,
        edge.metadata && Object.keys(edge.metadata).length > 0 ? JSON.stringify(edge.metadata) : null,
        edge.line ?? null,
        edge.column ?? null,
        edge.originRefKey ? 'structural-resolver' : edge.provenance ?? null,
        edge.originRefKey ?? null,
    ];
}
// ---------------------------------------------------------------------------
// KgQueryBuilder — 统一 CRUD 操作
// ---------------------------------------------------------------------------
export class KgQueryBuilder {
    conn;
    constructor(conn) {
        this.conn = conn;
    }
    get db() {
        return this.conn.raw;
    }
    // ── Node CRUD ──────────────────────────────────────────────────────
    insertNode(node) {
        const row = nodeToRow(node);
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(',');
        const updates = cols.filter(column => column !== 'id')
            .map(column => `${column}=excluded.${column}`).join(',');
        this.db.prepare(`INSERT INTO nodes (${cols.join(',')}) VALUES (${placeholders})
       ON CONFLICT(id) DO UPDATE SET ${updates}`).run(...cols.map(c => row[c]));
    }
    insertNodes(nodes) {
        if (nodes.length === 0)
            return 0;
        const stmt = this.db.prepare(`INSERT INTO nodes (
        id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column,
        docstring, signature, visibility, is_exported, is_async, is_static, is_abstract,
        decorators, type_parameters, source_type, definition, aliases, keywords,
        category, roles, priority, status, body, metadata, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        kind=excluded.kind,
        name=excluded.name,
        qualified_name=excluded.qualified_name,
        file_path=excluded.file_path,
        language=excluded.language,
        start_line=excluded.start_line,
        end_line=excluded.end_line,
        start_column=excluded.start_column,
        end_column=excluded.end_column,
        docstring=excluded.docstring,
        signature=excluded.signature,
        visibility=excluded.visibility,
        is_exported=excluded.is_exported,
        is_async=excluded.is_async,
        is_static=excluded.is_static,
        is_abstract=excluded.is_abstract,
        decorators=excluded.decorators,
        type_parameters=excluded.type_parameters,
        source_type=excluded.source_type,
        definition=excluded.definition,
        aliases=excluded.aliases,
        keywords=excluded.keywords,
        category=excluded.category,
        roles=excluded.roles,
        priority=excluded.priority,
        status=excluded.status,
        body=excluded.body,
        metadata=excluded.metadata,
        updated_at=excluded.updated_at`);
        let count = 0;
        for (const node of nodes) {
            let keywords = node.keywords;
            if (node.sourceType === 'codegraph' && keywords.length === 0) {
                const nameTokens = camelTokenize(node.name);
                const qnTokens = node.qualifiedName ? camelTokenize(node.qualifiedName.split('.').pop() || '') : [];
                const merged = [...new Set([...nameTokens, ...qnTokens])];
                if (merged.length > 1)
                    keywords = merged;
            }
            stmt.run(node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language, node.startLine, node.endLine, node.startColumn, node.endColumn, node.docstring || null, node.signature || null, node.visibility || null, node.isExported ? 1 : 0, node.isAsync ? 1 : 0, node.isStatic ? 1 : 0, node.isAbstract ? 1 : 0, node.decorators.length > 0 ? JSON.stringify(node.decorators) : null, node.typeParameters.length > 0 ? JSON.stringify(node.typeParameters) : null, node.sourceType, node.definition || null, node.aliases.length > 0 ? JSON.stringify(node.aliases) : null, keywords.length > 0 ? JSON.stringify(keywords) : null, node.category || null, node.roles.length > 0 ? JSON.stringify(node.roles) : null, node.priority || null, node.status || null, node.body || null, Object.keys(node.metadata).length > 0 ? JSON.stringify(node.metadata) : null, node.updatedAt);
            count++;
        }
        return count;
    }
    getNode(id) {
        const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
        return row ? rowToNode(row) : null;
    }
    getNodesByQualifiedName(qualifiedName) {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE qualified_name = ? ORDER BY id COLLATE BINARY').all(qualifiedName);
        return rows.map(rowToNode);
    }
    getNodesByName(name) {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE name = ? ORDER BY id COLLATE BINARY').all(name);
        return rows.map(rowToNode);
    }
    getNodesByIds(ids) {
        if (ids.length === 0)
            return new Map();
        // 分批查询，每批 500 参数 (D2.3: IN-clause 批量匹配)
        const BATCH_SIZE = 500;
        const result = new Map();
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            const batch = ids.slice(i, i + BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(',');
            const rows = this.db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...batch);
            for (const row of rows) {
                result.set(row.id, rowToNode(row));
            }
        }
        return result;
    }
    getNodesByKind(kinds) {
        if (kinds.length === 0)
            return [];
        const placeholders = kinds.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT * FROM nodes WHERE kind IN (${placeholders})`).all(...kinds);
        return rows.map(rowToNode);
    }
    getNodesByFile(filePath) {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line').all(filePath);
        return rows.map(rowToNode);
    }
    getNodesBySourceType(sourceType) {
        const rows = this.db.prepare('SELECT * FROM nodes WHERE source_type = ?').all(sourceType);
        return rows.map(rowToNode);
    }
    deleteNode(id) {
        this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
    }
    deleteNodesBySourceTypeAndFile(sourceType, filePath) {
        return Number(this.db.prepare('DELETE FROM nodes WHERE source_type = ? AND file_path = ?').run(sourceType, filePath).changes);
    }
    deleteNodesBySourceType(sourceType) {
        return Number(this.db.prepare('DELETE FROM nodes WHERE source_type = ?').run(sourceType).changes);
    }
    // ── Edge CRUD ──────────────────────────────────────────────────────
    insertEdge(edge) {
        if (edge.originRefKey) {
            this.upsertStructuralEdge(edge);
            return;
        }
        this.writeEdgeRow(edge);
    }
    writeEdgeRow(edge) {
        const row = edgeToSqlValues(edge);
        if (edge.originRefKey) {
            this.db.prepare(`INSERT INTO edges (source, target, kind, metadata, line, col, provenance, origin_ref_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(origin_ref_key) WHERE origin_ref_key IS NOT NULL DO UPDATE SET
           source = excluded.source,
           target = excluded.target,
           kind = excluded.kind,
           metadata = excluded.metadata,
           line = excluded.line,
           col = excluded.col,
           provenance = excluded.provenance`).run(...row);
            return;
        }
        this.db.prepare(`INSERT INTO edges (source, target, kind, metadata, line, col, provenance, origin_ref_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(...row);
    }
    insertEdges(edges) {
        if (edges.length === 0)
            return 0;
        const insertStmt = this.db.prepare(`INSERT INTO edges (source, target, kind, metadata, line, col, provenance, origin_ref_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
        let count = 0;
        for (const edge of edges) {
            if (edge.originRefKey) {
                this.upsertStructuralEdge(edge);
                count++;
                continue;
            }
            const values = edgeToSqlValues(edge);
            insertStmt.run(...values);
            count++;
        }
        return count;
    }
    upsertStructuralEdge(edge) {
        const ref = this.getStructuralReference(edge.originRefKey);
        if (!ref)
            throw new Error(`Structural reference not found: ${edge.originRefKey}`);
        if (ref.status !== 'resolved' || !ref.resolvedNodeId) {
            throw new Error(`Structural reference is not resolved: ${edge.originRefKey}`);
        }
        const expectedSource = ref.edgeOrientation === 'anchor-to-target'
            ? ref.anchorNodeId
            : ref.resolvedNodeId;
        const expectedTarget = ref.edgeOrientation === 'anchor-to-target'
            ? ref.resolvedNodeId
            : ref.anchorNodeId;
        if (edge.source !== expectedSource || edge.target !== expectedTarget) {
            throw new Error(`Structural edge endpoints do not match resolution: ${edge.originRefKey}`);
        }
        const allowedKinds = ref.relationHint === 'inherits-or-conforms'
            ? ['extends', 'implements']
            : ref.relationHint === 'contains-owner'
                ? ['contains']
                : [ref.relationHint];
        if (!allowedKinds.includes(edge.kind)) {
            throw new Error(`Structural edge kind does not match relation: ${edge.originRefKey}`);
        }
        this.writeEdgeRow({ ...edge, provenance: 'structural-resolver' });
    }
    getOutgoingEdges(nodeId, kind) {
        if (kind) {
            const rows = this.db.prepare('SELECT * FROM edges WHERE source = ? AND kind = ?').all(nodeId, kind);
            return rows.map(rowToEdge);
        }
        const rows = this.db.prepare('SELECT * FROM edges WHERE source = ?').all(nodeId);
        return rows.map(rowToEdge);
    }
    getIncomingEdges(nodeId, kind) {
        if (kind) {
            const rows = this.db.prepare('SELECT * FROM edges WHERE target = ? AND kind = ?').all(nodeId, kind);
            return rows.map(rowToEdge);
        }
        const rows = this.db.prepare('SELECT * FROM edges WHERE target = ?').all(nodeId);
        return rows.map(rowToEdge);
    }
    getOutgoingEdgesBatch(nodeIds) {
        const result = new Map();
        if (nodeIds.length === 0)
            return result;
        for (const id of nodeIds)
            result.set(id, []);
        const BATCH_SIZE = 500;
        for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
            const batch = nodeIds.slice(i, i + BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(',');
            const rows = this.db.prepare(`SELECT * FROM edges WHERE source IN (${placeholders})`).all(...batch);
            for (const row of rows) {
                const edge = rowToEdge(row);
                result.get(edge.source)?.push(edge);
            }
        }
        return result;
    }
    getIncomingEdgesBatch(nodeIds) {
        const result = new Map();
        if (nodeIds.length === 0)
            return result;
        for (const id of nodeIds)
            result.set(id, []);
        const BATCH_SIZE = 500;
        for (let i = 0; i < nodeIds.length; i += BATCH_SIZE) {
            const batch = nodeIds.slice(i, i + BATCH_SIZE);
            const placeholders = batch.map(() => '?').join(',');
            const rows = this.db.prepare(`SELECT * FROM edges WHERE target IN (${placeholders})`).all(...batch);
            for (const row of rows) {
                const edge = rowToEdge(row);
                result.get(edge.target)?.push(edge);
            }
        }
        return result;
    }
    deleteEdgesByProvenanceAndSource(provenance, sourcePrefix) {
        return Number(this.db.prepare("DELETE FROM edges WHERE provenance = ? AND source LIKE ? ESCAPE '\\'").run(provenance, `${escapeLikePattern(sourcePrefix)}%`).changes);
    }
    // ── Unresolved Refs CRUD ──────────────────────────────────────────
    insertUnresolvedRef(ref) {
        this.db.prepare(`INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language, candidates)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(ref.fromNodeId, ref.referenceName, ref.referenceKind, ref.line, ref.col, ref.filePath, ref.language, ref.candidates ? JSON.stringify(ref.candidates) : null);
    }
    getUnresolvedRefsByFile(filePath) {
        const rows = this.db.prepare('SELECT * FROM unresolved_refs WHERE file_path = ?').all(filePath);
        return rows.map(r => ({
            id: r.id, fromNodeId: r.from_node_id, referenceName: r.reference_name,
            referenceKind: r.reference_kind, line: r.line, col: r.col,
            filePath: r.file_path, language: r.language,
            candidates: safeJsonParse(r.candidates, []),
        }));
    }
    deleteUnresolvedRefsByFile(filePath) {
        return Number(this.db.prepare('DELETE FROM unresolved_refs WHERE file_path = ?').run(filePath).changes);
    }
    // ── Structural Refs CRUD ─────────────────────────────────────────
    /**
     * Stages replayable syntax facts. This method intentionally owns no
     * transaction; the codegraph replacement orchestrator is the transaction owner.
     */
    stageStructuralReferences(refs, now = Date.now()) {
        if (refs.length === 0)
            return 0;
        const deleteMaterializedEdge = this.db.prepare('DELETE FROM edges WHERE origin_ref_key = ?');
        const stmt = this.db.prepare(`
      INSERT INTO structural_refs (
        ref_key, anchor_node_id, anchor_qualified_name, ref_kind,
        raw_target_name, source_declaration_kind, lookup_scope,
        relation_hint, edge_orientation, target_kind_hints,
        target_language_hints, module_hints, target_file_hints,
        origin_file_path, origin_language, origin_line, origin_column,
        compilation_condition, evidence_provenance, resolved_node_id,
        status, candidates, resolution_strategy, confidence, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        NULL, ?, '[]', NULL, NULL, ?, ?
      )
      ON CONFLICT(ref_key) DO UPDATE SET
        anchor_node_id = excluded.anchor_node_id,
        anchor_qualified_name = excluded.anchor_qualified_name,
        ref_kind = excluded.ref_kind,
        raw_target_name = excluded.raw_target_name,
        source_declaration_kind = excluded.source_declaration_kind,
        lookup_scope = excluded.lookup_scope,
        relation_hint = excluded.relation_hint,
        edge_orientation = excluded.edge_orientation,
        target_kind_hints = excluded.target_kind_hints,
        target_language_hints = excluded.target_language_hints,
        module_hints = excluded.module_hints,
        target_file_hints = excluded.target_file_hints,
        origin_file_path = excluded.origin_file_path,
        origin_language = excluded.origin_language,
        origin_line = excluded.origin_line,
        origin_column = excluded.origin_column,
        compilation_condition = excluded.compilation_condition,
        evidence_provenance = excluded.evidence_provenance,
        resolved_node_id = NULL,
        status = excluded.status,
        candidates = '[]',
        resolution_strategy = NULL,
        confidence = NULL,
        updated_at = excluded.updated_at
    `);
        let count = 0;
        for (const ref of refs) {
            assertStructuralReference(ref);
            if (ref.status === 'resolved') {
                throw new Error('staged structural references cannot already be resolved');
            }
            deleteMaterializedEdge.run(ref.refKey);
            stmt.run(ref.refKey, ref.anchorNodeId, ref.anchorQualifiedName, ref.kind, ref.rawTargetName, ref.sourceDeclarationKind, ref.lookupScope, ref.relationHint, ref.edgeOrientation, JSON.stringify(ref.targetKindHints), JSON.stringify(ref.targetLanguageHints), JSON.stringify(ref.moduleHints), JSON.stringify(ref.targetFileHints), ref.origin.filePath, ref.origin.language, ref.origin.line, ref.origin.column, ref.compilationCondition ?? null, ref.evidenceProvenance, ref.status ?? 'pending', now, now);
            count++;
        }
        return count;
    }
    upsertStructuralReferences(refs, now = Date.now()) {
        return this.stageStructuralReferences(refs, now);
    }
    getStructuralReference(refKey) {
        const row = this.db.prepare('SELECT * FROM structural_refs WHERE ref_key = ?').get(refKey);
        return row ? rowToStructuralReference(row) : null;
    }
    listStructuralReferences(filter = {}) {
        const { sql, params } = buildStructuralReferenceWhere(filter);
        const rows = this.db.prepare(`SELECT * FROM structural_refs${sql} ORDER BY origin_file_path, origin_line, origin_column, ref_key`).all(...params);
        return rows.map(rowToStructuralReference);
    }
    updateStructuralReferenceResolution(refKey, resolution, now = Date.now()) {
        validateStructuralReferenceStatus(resolution.status);
        const resolvedNodeId = resolution.resolvedNodeId ?? null;
        if (resolution.status === 'resolved' && !resolvedNodeId) {
            throw new Error('resolved structural reference requires resolvedNodeId');
        }
        if (resolution.status !== 'resolved' && resolvedNodeId) {
            throw new Error(`${resolution.status} structural reference cannot carry resolvedNodeId`);
        }
        const candidates = resolution.candidates ?? [];
        if (candidates.some(candidate => typeof candidate !== 'string')) {
            throw new Error('structural reference candidates must be strings');
        }
        const canonicalCandidates = [...new Set(candidates)]
            .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
        if (canonicalCandidates.length !== candidates.length
            || canonicalCandidates.some((candidate, index) => candidate !== candidates[index])) {
            throw new Error('structural reference candidates must be unique and bytewise sorted');
        }
        if (resolution.status === 'resolved'
            && (canonicalCandidates.length !== 1 || canonicalCandidates[0] !== resolvedNodeId)) {
            throw new Error('resolved structural reference requires its one candidate to equal resolvedNodeId');
        }
        if (resolution.status === 'not_found' && canonicalCandidates.length !== 0) {
            throw new Error('not_found structural reference requires empty candidates');
        }
        const confidence = resolution.confidence ?? null;
        if (confidence !== null && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
            throw new Error('structural reference confidence must be between 0 and 1');
        }
        // A resolution update invalidates any prior materialization. The resolver
        // writes the replacement edge after this call in the caller-owned transaction.
        this.db.prepare('DELETE FROM edges WHERE origin_ref_key = ?').run(refKey);
        const result = this.db.prepare(`
      UPDATE structural_refs
      SET resolved_node_id = ?, status = ?, candidates = ?,
          resolution_strategy = ?, confidence = ?, updated_at = ?
      WHERE ref_key = ?
    `).run(resolvedNodeId, resolution.status, JSON.stringify(canonicalCandidates), resolution.strategy ?? null, confidence, now, refKey);
        if (Number(result.changes) !== 1) {
            throw new Error(`Structural reference not found: ${refKey}`);
        }
    }
    setStructuralReferenceResolution(refKey, resolution, now = Date.now()) {
        this.updateStructuralReferenceResolution(refKey, resolution, now);
    }
    resetStructuralReferenceStatuses(filter = {}, now = Date.now()) {
        const { sql, params } = buildStructuralReferenceWhere(filter);
        this.db.prepare(`DELETE FROM edges WHERE origin_ref_key IN (SELECT ref_key FROM structural_refs${sql})`).run(...params);
        return Number(this.db.prepare(`
      UPDATE structural_refs
      SET resolved_node_id = NULL,
          status = 'pending',
          candidates = '[]',
          resolution_strategy = NULL,
          confidence = NULL,
          updated_at = ?${sql}
    `).run(now, ...params).changes);
    }
    getStructuralReferenceStatusCounts() {
        const counts = Object.fromEntries(STRUCTURAL_REFERENCE_STATUSES.map(status => [status, 0]));
        const rows = this.db.prepare('SELECT status, COUNT(*) AS count FROM structural_refs GROUP BY status').all();
        for (const row of rows) {
            validateStructuralReferenceStatus(row.status);
            counts[row.status] = row.count;
        }
        return counts;
    }
    countStructuralReferencesByStatus() {
        return this.getStructuralReferenceStatusCounts();
    }
    getStructuralReferenceInvariantCounts() {
        const rows = this.db.prepare(`
      SELECT
        r.ref_key,
        r.anchor_node_id,
        r.resolved_node_id,
        r.relation_hint,
        r.edge_orientation,
        e.source AS edge_source,
        e.target AS edge_target,
        e.kind AS edge_kind
      FROM structural_refs r
      LEFT JOIN edges e ON e.origin_ref_key = r.ref_key
      WHERE r.status = 'resolved'
      ORDER BY r.ref_key COLLATE BINARY
    `).all();
        const result = {
            invalidResolved: 0,
            resolvedWithoutTarget: 0,
            resolvedWithoutOriginEdge: 0,
            invalidOriginEdge: 0,
        };
        for (const row of rows) {
            if (!row.resolved_node_id) {
                result.resolvedWithoutTarget++;
                result.invalidResolved++;
                continue;
            }
            if (!row.edge_source || !row.edge_target || !row.edge_kind) {
                result.resolvedWithoutOriginEdge++;
                result.invalidResolved++;
                continue;
            }
            const expectedSource = row.edge_orientation === 'anchor-to-target'
                ? row.anchor_node_id
                : row.resolved_node_id;
            const expectedTarget = row.edge_orientation === 'anchor-to-target'
                ? row.resolved_node_id
                : row.anchor_node_id;
            const allowedKinds = row.relation_hint === 'inherits-or-conforms'
                ? new Set(['extends', 'implements'])
                : new Set([row.relation_hint === 'contains-owner' ? 'contains' : row.relation_hint]);
            if (row.edge_source !== expectedSource
                || row.edge_target !== expectedTarget
                || !allowedKinds.has(row.edge_kind)) {
                result.invalidOriginEdge++;
                result.invalidResolved++;
            }
        }
        return result;
    }
    deleteStructuralReferencesByOriginFile(filePath) {
        return Number(this.db.prepare('DELETE FROM structural_refs WHERE origin_file_path = ?').run(filePath).changes);
    }
    // ── File CRUD ──────────────────────────────────────────────────────
    upsertFile(record) {
        this.db.prepare(`INSERT OR REPLACE INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors, source_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.path, record.contentHash, record.language, record.size, record.modifiedAt, record.indexedAt, record.nodeCount, record.errors.length > 0 ? JSON.stringify(record.errors) : null, record.sourceType);
    }
    deleteFilesBySourceType(sourceType) {
        const sql = sourceType === 'codegraph'
            ? "DELETE FROM files WHERE source_type = 'codegraph' OR source_type IS NULL"
            : 'DELETE FROM files WHERE source_type = ?';
        return Number((sourceType === 'codegraph'
            ? this.db.prepare(sql).run()
            : this.db.prepare(sql).run(sourceType)).changes);
    }
    getFile(filePath) {
        const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(filePath);
        if (!row)
            return null;
        return {
            path: row.path,
            contentHash: row.content_hash ?? '',
            language: (row.language ?? 'unknown'),
            size: row.size ?? 0,
            modifiedAt: row.modified_at ?? 0,
            indexedAt: row.indexed_at ?? 0,
            nodeCount: row.node_count,
            errors: safeJsonParse(row.errors, []),
            sourceType: (row.source_type ?? 'codegraph'),
        };
    }
    /** Includes zero-symbol files so scan-scoped Unicode collisions stay fail-closed. */
    getFilePathsBySourceType(sourceType) {
        const rows = this.db.prepare('SELECT path FROM files WHERE source_type = ? ORDER BY path COLLATE BINARY').all(sourceType);
        return rows.map(row => row.path);
    }
    getStaleFiles() {
        return this.db.prepare('SELECT * FROM files WHERE modified_at > indexed_at').all();
    }
    /**
     * Reconciles the selective internal-storage FTS index inside the caller's
     * transaction. The FTS5 `delete-all` command is invalid for this table mode,
     * so use an ordinary DELETE before the filtered refill.
     */
    rebuildCodeFtsStrict() {
        this.db.exec(`
      DELETE FROM code_fts;
      INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
      SELECT rowid, id, name, qualified_name, docstring, signature, keywords
      FROM nodes WHERE source_type = 'codegraph';
    `);
        const mismatch = this.db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT identity FROM (
          SELECT rowid AS identity FROM nodes WHERE source_type = 'codegraph'
          EXCEPT
          SELECT id AS identity FROM code_fts_docsize
        )
        UNION ALL
        SELECT identity FROM (
          SELECT id AS identity FROM code_fts_docsize
          EXCEPT
          SELECT rowid AS identity FROM nodes WHERE source_type = 'codegraph'
        )
      )
    `).get();
        if (mismatch.count !== 0) {
            throw new Error(`code_fts reconciliation mismatch: ${mismatch.count}`);
        }
        return Number(this.db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE source_type = 'codegraph'").get().count);
    }
    // ── Stats ──────────────────────────────────────────────────────────
    getStats(dbSizeBytes) {
        const nodeCount = this.db.prepare('SELECT COUNT(*) as n FROM nodes').get().n;
        const edgeCount = this.db.prepare('SELECT COUNT(*) as n FROM edges').get().n;
        const fileCount = this.db.prepare('SELECT COUNT(*) as n FROM files').get().n;
        const nodesByKind = {};
        const kindRows = this.db.prepare('SELECT kind, COUNT(*) as n FROM nodes GROUP BY kind').all();
        for (const r of kindRows)
            nodesByKind[r.kind] = r.n;
        const edgesByKind = {};
        const edgeKindRows = this.db.prepare('SELECT kind, COUNT(*) as n FROM edges GROUP BY kind').all();
        for (const r of edgeKindRows)
            edgesByKind[r.kind] = r.n;
        const nodesBySourceType = {};
        const sourceRows = this.db.prepare('SELECT source_type, COUNT(*) as n FROM nodes GROUP BY source_type').all();
        for (const r of sourceRows)
            nodesBySourceType[r.source_type] = r.n;
        const staleCount = this.db.prepare('SELECT COUNT(*) as n FROM files WHERE modified_at > indexed_at').get().n;
        const stalenessRatio = fileCount > 0 ? staleCount / fileCount : 0;
        const detectedFrameworks = [];
        try {
            const fwStr = this.db.prepare("SELECT value FROM project_metadata WHERE key = 'detected_frameworks'").get();
            if (fwStr)
                detectedFrameworks.push(...safeJsonParse(fwStr.value, []));
        }
        catch { /* ignore */ }
        const schemaVersion = this.conn.getSchemaVersion();
        const structuralStatus = Object.fromEntries(STRUCTURAL_REFERENCE_STATUSES.map(status => [status, 0]));
        const structuralStatusRows = this.db.prepare('SELECT status, COUNT(*) AS n FROM structural_refs GROUP BY status ORDER BY status COLLATE BINARY').all();
        for (const row of structuralStatusRows)
            structuralStatus[row.status] = row.n;
        const structuralRelation = {};
        const structuralRelationRows = this.db.prepare('SELECT relation_hint, COUNT(*) AS n FROM structural_refs GROUP BY relation_hint ORDER BY relation_hint COLLATE BINARY').all();
        for (const row of structuralRelationRows)
            structuralRelation[row.relation_hint] = row.n;
        const structuralLanguage = {};
        const structuralLanguageRows = this.db.prepare('SELECT origin_language, COUNT(*) AS n FROM structural_refs GROUP BY origin_language ORDER BY origin_language COLLATE BINARY').all();
        for (const row of structuralLanguageRows)
            structuralLanguage[row.origin_language] = row.n;
        const structuralTotal = structuralStatusRows.reduce((sum, row) => sum + row.n, 0);
        const exactSurfaceSql = `CASE
      WHEN metadata IS NOT NULL AND json_valid(metadata)
        THEN COALESCE(json_extract(metadata, '$.externalSurface'), 0)
      ELSE 0
    END`;
        const externalRow = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN file_path LIKE '@external/apple/%' THEN 1 ELSE 0 END) AS apple_catalog,
        SUM(CASE WHEN ${exactSurfaceSql} = 1 THEN 1 ELSE 0 END) AS exact_surfaces
      FROM nodes
      WHERE source_type = 'codegraph'
        AND (file_path LIKE '@external/%' OR ${exactSurfaceSql} = 1)
    `).get();
        const externalLanguage = {};
        const externalLanguageRows = this.db.prepare(`
      SELECT language, COUNT(*) AS n
      FROM nodes
      WHERE source_type = 'codegraph'
        AND (file_path LIKE '@external/%' OR ${exactSurfaceSql} = 1)
      GROUP BY language
      ORDER BY language COLLATE BINARY
    `).all();
        for (const row of externalLanguageRows)
            externalLanguage[row.language] = row.n;
        return {
            nodeCount, edgeCount, fileCount, dbSizeBytes,
            nodesByKind, edgesByKind, nodesBySourceType,
            detectedFrameworks, schemaVersion, stalenessRatio,
            structuralRefs: {
                total: structuralTotal,
                status: structuralStatus,
                relation: structuralRelation,
                language: structuralLanguage,
            },
            externalNodes: {
                total: externalRow.total,
                appleCatalog: externalRow.apple_catalog ?? 0,
                exactSurfaces: externalRow.exact_surfaces ?? 0,
                language: externalLanguage,
            },
        };
    }
    // ── Search — FTS5 统一搜索 (D1.5: 输入消毒) ───────────────────────
    searchCodeFTS(query, opts) {
        if (hasCjkChars(query)) {
            return this.searchNodesLike(query, opts);
        }
        const sanitized = sanitizeFtsQuery(query);
        if (!sanitized)
            return [];
        const results = this.runCodeFtsQuery(sanitized, opts);
        if (results.length > 0)
            return results;
        // Multi-word AND returned 0 — retry with OR semantics
        const tokens = sanitized.match(/"[^"]+"/g);
        if (tokens && tokens.length > 1) {
            const orQuery = tokens.join(' OR ');
            const orResults = this.runCodeFtsQuery(orQuery, opts);
            if (orResults.length > 0)
                return orResults;
        }
        return this.searchNodesLike(query, opts);
    }
    runCodeFtsQuery(matchExpr, opts) {
        try {
            let sql = `
        SELECT n.*, bm25(code_fts, 0, 20, 5, 1, 2, 10) AS score
        FROM code_fts JOIN nodes n ON code_fts.id = n.id
        WHERE code_fts MATCH ? AND n.source_type = 'codegraph'
      `;
            const params = [matchExpr];
            if (opts.kinds && opts.kinds.length > 0) {
                sql += ` AND n.kind IN (${opts.kinds.map(() => '?').join(',')})`;
                params.push(...opts.kinds);
            }
            if (opts.languages && opts.languages.length > 0) {
                sql += ` AND n.language IN (${opts.languages.map(() => '?').join(',')})`;
                params.push(...opts.languages);
            }
            sql += ` ORDER BY score LIMIT ?`;
            params.push(clampQueryLimit(opts.limit, 20, 500));
            const rows = this.db.prepare(sql).all(...params);
            return rows.map(r => {
                const node = rowToNode(r);
                if (typeof r.score === 'number')
                    node._bm25Score = -r.score;
                return node;
            });
        }
        catch (err) {
            if (isFtsCorruption(err)) {
                process.stderr.write('[KG] MaestroGraph database corruption detected; run "maestro kg rebuild --confirm" if automatic repair fails.\n');
            }
            if (isRecoverableFtsFailure(err, 'code_fts') && this.tryRebuildCodeFts()) {
                try {
                    return this.runCodeFtsQuery(matchExpr, opts);
                }
                catch { /* rebuild didn't help — fall through */ }
            }
            if (process.env.MAESTRO_DEBUG === '1')
                console.warn('[KG] code FTS5 failed, LIKE fallback:', err);
            return [];
        }
    }
    codeFtsRebuilt = false;
    tryRebuildCodeFts() {
        if (this.codeFtsRebuilt)
            return false;
        this.codeFtsRebuilt = true;
        try {
            this.conn.transaction(() => {
                this.db.exec(`
          DROP TABLE IF EXISTS code_fts;
          CREATE VIRTUAL TABLE code_fts USING fts5(
            id, name, qualified_name, docstring, signature, keywords,
            tokenize = 'unicode61 remove_diacritics 2'
          );
          INSERT INTO code_fts(rowid, id, name, qualified_name, docstring, signature, keywords)
          SELECT rowid, id, name, qualified_name, docstring, signature, keywords
          FROM nodes WHERE source_type = 'codegraph';
        `);
            });
            if (process.env.MAESTRO_DEBUG === '1')
                console.warn('[KG] code_fts recreated from nodes table');
            return true;
        }
        catch (err) {
            process.stderr.write(`[KG] code_fts rebuild failed: ${err instanceof Error ? err.message : String(err)}\n`);
            return false;
        }
    }
    searchKnowledgeFTS(query, opts) {
        const isCjkShort = /^[㐀-䶿一-鿿぀-ヿ가-힯]{1,2}$/.test(query.trim());
        if (isCjkShort) {
            return this.searchKnowledgeLike(query, opts);
        }
        const sanitized = sanitizeFtsQuery(query);
        if (!sanitized)
            return [];
        const results = this.runKnowledgeFtsQuery(sanitized, opts);
        const tokens = sanitized.match(/"[^"]+"/g);
        if (tokens && tokens.length > 1) {
            const orQuery = tokens.join(' OR ');
            const orResults = this.runKnowledgeFtsQuery(orQuery, opts);
            if (orResults.length > 0) {
                const byId = new Map(results.map(node => [node.id, node]));
                for (const node of orResults) {
                    if (!byId.has(node.id))
                        byId.set(node.id, node);
                }
                return [...byId.values()].slice(0, clampQueryLimit(opts.limit, 20, 500));
            }
        }
        if (results.length > 0)
            return results;
        return this.searchKnowledgeLike(query, opts);
    }
    runKnowledgeFtsQuery(matchExpr, opts) {
        try {
            let sql = `
        SELECT n.*, bm25(knowledge_fts, 0, 20, 10, 1, 15, 10) AS score
        FROM knowledge_fts JOIN nodes n ON knowledge_fts.id = n.id
        WHERE knowledge_fts MATCH ? AND n.source_type != 'codegraph'
      `;
            const params = [matchExpr];
            const sourceTypes = opts.sourceTypes?.slice(0, 6);
            if (sourceTypes && sourceTypes.length > 0) {
                sql += ` AND n.source_type IN (${sourceTypes.map(() => '?').join(',')})`;
                params.push(...sourceTypes);
            }
            sql += ` ORDER BY score LIMIT ?`;
            params.push(clampQueryLimit(opts.limit, 20, 500));
            const rows = this.db.prepare(sql).all(...params);
            return rows.map(r => {
                const node = rowToNode(r);
                if (typeof r.score === 'number')
                    node._bm25Score = -r.score;
                return node;
            });
        }
        catch (err) {
            if (isFtsCorruption(err)) {
                process.stderr.write('[KG] MaestroGraph database corruption detected; run "maestro kg rebuild --confirm" if automatic repair fails.\n');
            }
            if (isRecoverableFtsFailure(err, 'knowledge_fts') && this.tryRebuildKnowledgeFts()) {
                try {
                    return this.runKnowledgeFtsQuery(matchExpr, opts);
                }
                catch { /* rebuild didn't help */ }
            }
            if (process.env.MAESTRO_DEBUG === '1')
                console.warn('[KG] knowledge FTS5 failed, LIKE fallback:', err);
            return [];
        }
    }
    knowledgeFtsRebuilt = false;
    tryRebuildKnowledgeFts() {
        if (this.knowledgeFtsRebuilt)
            return false;
        this.knowledgeFtsRebuilt = true;
        try {
            this.conn.transaction(() => {
                this.db.exec(`
          DROP TABLE IF EXISTS knowledge_fts;
          CREATE VIRTUAL TABLE knowledge_fts USING fts5(
            id, name, definition, body, aliases, keywords,
            tokenize = 'trigram'
          );
          INSERT INTO knowledge_fts(rowid, id, name, definition, body, aliases, keywords)
          SELECT rowid, id, name, definition, body, aliases, keywords
          FROM nodes WHERE source_type != 'codegraph';
        `);
            });
            if (process.env.MAESTRO_DEBUG === '1')
                console.warn('[KG] knowledge_fts recreated from nodes table');
            return true;
        }
        catch (err) {
            process.stderr.write(`[KG] knowledge_fts rebuild failed: ${err instanceof Error ? err.message : String(err)}\n`);
            return false;
        }
    }
    searchUnified(query, opts) {
        const codeResults = this.searchCodeFTS(query, { limit: opts.limit ?? 10 });
        const knowledgeResults = this.searchKnowledgeFTS(query, { limit: opts.limit ?? 10, sourceTypes: opts.sourceTypes });
        return [...codeResults, ...knowledgeResults];
    }
    searchNodesLike(query, opts) {
        const words = query.split(/\s+/).filter(w => w.length > 0);
        const FIELDS = ['name', 'qualified_name', 'docstring', 'signature'];
        let whereClause;
        const params = [];
        if (words.length <= 1) {
            const escaped = escapeLikePattern(query);
            const fieldConds = FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ');
            whereClause = `(${fieldConds})`;
            params.push(...FIELDS.map(() => `%${escaped}%`));
        }
        else {
            // Each word must match at least one field (AND across words, OR across fields)
            const wordClauses = words.map(w => {
                const escaped = escapeLikePattern(w);
                const fieldConds = FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ');
                params.push(...FIELDS.map(() => `%${escaped}%`));
                return `(${fieldConds})`;
            });
            whereClause = wordClauses.join(' AND ');
        }
        let sql = `SELECT * FROM nodes WHERE source_type = 'codegraph' AND ${whereClause}`;
        if (opts.kinds && opts.kinds.length > 0) {
            sql += ` AND kind IN (${opts.kinds.map(() => '?').join(',')})`;
            params.push(...opts.kinds);
        }
        if (opts.languages && opts.languages.length > 0) {
            sql += ` AND language IN (${opts.languages.map(() => '?').join(',')})`;
            params.push(...opts.languages);
        }
        // LIKE has no bm25 — fetch a wider candidate pool, then rank by the
        // multi-signal relevance score (name match > path > kind) — G-C5.
        const requested = clampQueryLimit(opts.limit, 20, 500);
        sql += ` ORDER BY name LIMIT ?`;
        params.push(Math.min(requested * 3, 500));
        const rows = this.db.prepare(sql).all(...params);
        const scored = rows.map(r => {
            const node = rowToNode(r);
            node._computedScore = computeScore(node, query);
            return node;
        });
        scored.sort((a, b) => (b._computedScore ?? 0) - (a._computedScore ?? 0)
            || compareNodeTie(a, b));
        return scored.slice(0, requested);
    }
    searchKnowledgeLike(query, opts) {
        const words = query.split(/\s+/).filter(w => w.length > 0);
        const FIELDS = ['name', 'definition', 'aliases', 'keywords', 'body'];
        let whereClause;
        const params = [];
        if (words.length <= 1) {
            const escaped = escapeLikePattern(query);
            const fieldConds = FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ');
            whereClause = `(${fieldConds})`;
            params.push(...FIELDS.map(() => `%${escaped}%`));
        }
        else {
            const wordClauses = words.map(w => {
                const escaped = escapeLikePattern(w);
                const fieldConds = FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ');
                params.push(...FIELDS.map(() => `%${escaped}%`));
                return `(${fieldConds})`;
            });
            whereClause = wordClauses.join(' AND ');
        }
        let sql = `SELECT * FROM nodes WHERE source_type != 'codegraph' AND ${whereClause}`;
        const sourceTypes = opts.sourceTypes?.slice(0, 6);
        if (sourceTypes && sourceTypes.length > 0) {
            sql += ` AND source_type IN (${sourceTypes.map(() => '?').join(',')})`;
            params.push(...sourceTypes);
        }
        const requested = clampQueryLimit(opts.limit, 20, 500);
        sql += ` ORDER BY name LIMIT ?`;
        params.push(Math.min(requested * 3, 500));
        const rows = this.db.prepare(sql).all(...params);
        const scored = rows.map(row => {
            const node = rowToNode(row);
            node._computedScore = computeScore(node, query);
            return node;
        });
        scored.sort((a, b) => (b._computedScore ?? 0) - (a._computedScore ?? 0)
            || compareNodeTie(a, b));
        return scored.slice(0, requested);
    }
}
// ---------------------------------------------------------------------------
// Structural reference filter builder
// ---------------------------------------------------------------------------
function buildStructuralReferenceWhere(filter) {
    const clauses = [];
    const params = [];
    const appendValues = (column, values) => {
        if (values === undefined)
            return;
        if (values.length === 0) {
            clauses.push('0 = 1');
            return;
        }
        clauses.push(`${column} IN (${values.map(() => '?').join(',')})`);
        params.push(...values);
    };
    appendValues('ref_key', filter.refKeys);
    appendValues('origin_file_path', filter.originFilePaths);
    if (filter.statuses) {
        for (const status of filter.statuses)
            validateStructuralReferenceStatus(status);
        appendValues('status', filter.statuses);
    }
    return {
        sql: clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '',
        params,
    };
}
// ---------------------------------------------------------------------------
// LIKE 通配符转义 (AC13)
// ---------------------------------------------------------------------------
function escapeLikePattern(input) {
    return input.replace(/[%_\\]/g, '\\$&');
}
// ---------------------------------------------------------------------------
// FTS5 输入消毒 (D1.5)
// ---------------------------------------------------------------------------
function hasCjkChars(input) {
    return /[㐀-䶿一-鿿぀-ヿ가-힯]/.test(input);
}
const FTS5_SPECIAL_CHARS = /[*"(){}[\]:^~+\-!\\]/g;
const FTS5_OPERATORS = new Set(['and', 'or', 'not', 'near']);
export function sanitizeFtsQuery(input) {
    const tokens = input.replace(FTS5_SPECIAL_CHARS, ' ').split(/\s+/)
        .filter(t => t.length > 0)
        .filter(t => !FTS5_OPERATORS.has(t.toLowerCase()));
    if (tokens.length === 0)
        return '';
    return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}
//# sourceMappingURL=queries.js.map