import { resolve } from 'node:path';
import { CredibilityStore, contentHash, wikiIdToNodeId } from './credibility.js';
import { validateNodeId } from './db/types.js';
import { MaestroGraph } from './engine.js';
function resolveNodeId(ref) {
    if (ref.sourceRef && validateNodeId(ref.sourceRef))
        return ref.sourceRef;
    return wikiIdToNodeId(ref.id);
}
/**
 * Record only explicit content loads. Listing and search result exposure must
 * not call this function.
 */
export function recordKnowledgeConsumptionsDetailed(projectRoot, refs, nowMs = Date.now()) {
    if (refs.length === 0)
        return { recorded: 0, nodeIds: [] };
    let graph = null;
    try {
        const root = resolve(projectRoot);
        if (!MaestroGraph.isInitialized(root))
            return { recorded: 0, nodeIds: [] };
        graph = MaestroGraph.openSync(root);
        if (!graph)
            return { recorded: 0, nodeIds: [] };
        const candidateIds = [...new Set(refs.map(resolveNodeId).filter((id) => Boolean(id)))];
        if (candidateIds.length === 0)
            return { recorded: 0, nodeIds: [] };
        const existingNodes = graph.getQueryBuilder().getNodesByIds(candidateIds);
        const existingIds = [...existingNodes.keys()];
        if (existingIds.length === 0)
            return { recorded: 0, nodeIds: [] };
        const store = new CredibilityStore(graph.rawDb);
        graph.getConnection().transaction(() => {
            for (const [id, node] of existingNodes) {
                store.upsert(id, contentHash(`${node.name}\n${node.definition ?? ''}\n${node.body ?? ''}`), nowMs);
            }
            store.incrementConsumptions(existingIds, nowMs);
        });
        return { recorded: existingIds.length, nodeIds: existingIds };
    }
    catch {
        return { recorded: 0, nodeIds: [] };
    }
    finally {
        graph?.close();
    }
}
export function recordKnowledgeConsumptions(projectRoot, refs, nowMs = Date.now()) {
    return recordKnowledgeConsumptionsDetailed(projectRoot, refs, nowMs).recorded;
}
/**
 * Read exposure/use counters for retrieval diversification. Signals are keyed
 * by the caller's Wiki id and are never folded into the relevance score.
 */
export function readKnowledgeUsageSignals(projectRoot, refs) {
    const output = new Map();
    if (refs.length === 0)
        return output;
    let graph = null;
    try {
        const root = resolve(projectRoot);
        if (!MaestroGraph.isInitialized(root))
            return output;
        graph = MaestroGraph.openSync(root);
        if (!graph)
            return output;
        const store = new CredibilityStore(graph.rawDb);
        const resolved = refs
            .map(ref => ({ ref, nodeId: resolveNodeId(ref) }))
            .filter((item) => Boolean(item.nodeId));
        const rows = store.getMany([...new Set(resolved.map(item => item.nodeId))]);
        for (const item of resolved) {
            const row = rows.get(item.nodeId);
            if (!row)
                continue;
            output.set(item.ref.id, {
                impressions: row.search_hits,
                consumptions: row.consumption_count,
            });
        }
        return output;
    }
    catch {
        return output;
    }
    finally {
        graph?.close();
    }
}
function concentration(values) {
    const positive = values.filter(value => value > 0).sort((a, b) => b - a);
    const total = positive.reduce((sum, value) => sum + value, 0);
    if (total === 0) {
        return {
            positiveNodes: 0,
            totalEvents: 0,
            top1Share: 0,
            top5Share: 0,
            top10Share: 0,
            gini: 0,
            hhi: 0,
            effectiveNodes: 0,
        };
    }
    const share = (count) => positive.slice(0, count).reduce((sum, value) => sum + value, 0) / total;
    const ascending = [...positive].sort((a, b) => a - b);
    const weighted = ascending.reduce((sum, value, index) => sum + (index + 1) * value, 0);
    const nodeCount = ascending.length;
    const gini = (2 * weighted) / (nodeCount * total) - (nodeCount + 1) / nodeCount;
    const hhi = positive.reduce((sum, value) => sum + (value / total) ** 2, 0);
    return {
        positiveNodes: positive.length,
        totalEvents: total,
        top1Share: share(1),
        top5Share: share(5),
        top10Share: share(10),
        gini,
        hhi,
        effectiveNodes: hhi > 0 ? 1 / hhi : 0,
    };
}
export function buildKnowledgeUsageStats(db, sourceType = null, topLimit = 10) {
    const where = sourceType
        ? 'WHERE n.source_type = ?'
        : `WHERE n.source_type != 'codegraph'`;
    const params = sourceType ? [sourceType] : [];
    const sourceRows = db.prepare(`
    SELECT
      n.source_type,
      COUNT(*) AS nodes,
      SUM(CASE WHEN c.node_id IS NOT NULL THEN 1 ELSE 0 END) AS tracked,
      SUM(CASE WHEN COALESCE(c.search_hits, 0) > 0 THEN 1 ELSE 0 END) AS impression_nodes,
      SUM(CASE WHEN COALESCE(c.consumption_count, 0) > 0 THEN 1 ELSE 0 END) AS consumed_nodes,
      COALESCE(SUM(c.search_hits), 0) AS impressions,
      COALESCE(SUM(c.consumption_count), 0) AS consumptions
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${where}
    GROUP BY n.source_type
    ORDER BY n.source_type
  `).all(...params);
    const valuesWhere = sourceType
        ? 'WHERE n.source_type = ?'
        : `WHERE n.source_type != 'codegraph'`;
    const impressionValues = db.prepare(`
    SELECT COALESCE(c.search_hits, 0) AS value
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${valuesWhere}
  `).all(...params);
    const consumptionValues = db.prepare(`
    SELECT COALESCE(c.consumption_count, 0) AS value
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${valuesWhere}
  `).all(...params);
    const topRows = db.prepare(`
    SELECT
      n.source_type,
      n.id,
      n.name,
      COALESCE(c.search_hits, 0) AS impressions,
      COALESCE(c.consumption_count, 0) AS consumptions,
      c.last_hit_at AS last_impression_at,
      c.last_consumed_at AS last_consumed_at
    FROM nodes n
    LEFT JOIN credibility c ON c.node_id = n.id
    ${where}
      AND (COALESCE(c.search_hits, 0) > 0 OR COALESCE(c.consumption_count, 0) > 0)
    ORDER BY impressions DESC, consumptions DESC, n.id
    LIMIT ?
  `).all(...params, Math.max(0, topLimit));
    return {
        schemaVersion: 'knowledge-usage-stats/1.0',
        semantics: {
            impressions: 'returned-or-injected',
            consumptions: 'explicit-content-load',
            affectsRanking: false,
            impressionsMayFillExplorationSlot: true,
            consumptionsAffectRetrieval: false,
        },
        filter: { sourceType },
        bySource: sourceRows.map(row => ({
            sourceType: row.source_type,
            nodes: Number(row.nodes),
            tracked: Number(row.tracked),
            impressionNodes: Number(row.impression_nodes),
            consumedNodes: Number(row.consumed_nodes),
            impressions: Number(row.impressions),
            consumptions: Number(row.consumptions),
        })),
        impressionConcentration: concentration(impressionValues.map(row => Number(row.value))),
        consumptionConcentration: concentration(consumptionValues.map(row => Number(row.value))),
        topEntries: topRows.map(row => ({
            sourceType: row.source_type,
            id: row.id,
            name: row.name,
            impressions: Number(row.impressions),
            consumptions: Number(row.consumptions),
            lastImpressionAt: row.last_impression_at,
            lastConsumedAt: row.last_consumed_at,
        })),
    };
}
//# sourceMappingURL=knowledge-usage.js.map