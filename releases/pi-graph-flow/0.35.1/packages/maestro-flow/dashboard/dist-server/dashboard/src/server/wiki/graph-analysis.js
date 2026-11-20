const LINK_RE = /\[\[([^\]]+)\]\]/g;
/**
 * Compute forward links + broken links from the current index. Backlinks are
 * already computed by WikiIndexer; we reuse them so the graph is consistent.
 */
export function buildGraph(index) {
    const forwardLinks = {};
    const broken = [];
    const titleIndex = new Map();
    for (const d of index.entries)
        titleIndex.set(d.title.toLowerCase(), d.id);
    const resolve = (target) => {
        if (index.byId[target])
            return target;
        const hit = titleIndex.get(target.toLowerCase());
        return hit ?? null;
    };
    const fwdSets = new Map();
    const pushFwd = (source, targetId) => {
        let s = fwdSets.get(source);
        if (!s) {
            s = new Set();
            fwdSets.set(source, s);
        }
        s.add(targetId);
    };
    for (const d of index.entries) {
        // `related` frontmatter
        for (const rel of d.related) {
            const hit = resolve(rel);
            if (hit)
                pushFwd(d.id, hit);
            else
                broken.push({ sourceId: d.id, target: rel });
        }
        // `parent` → child-to-parent forward link
        if (d.parent) {
            const hit = resolve(d.parent);
            if (hit)
                pushFwd(d.id, hit);
            // broken parent refs are not tracked as broken links — they are
            // informational only and may reference entries outside the wiki.
        }
        // inline body wikilinks
        if (d.body) {
            LINK_RE.lastIndex = 0;
            let m;
            while ((m = LINK_RE.exec(d.body))) {
                const hit = resolve(m[1]);
                if (hit)
                    pushFwd(d.id, hit);
                else
                    broken.push({ sourceId: d.id, target: m[1] });
            }
        }
    }
    for (const [k, v] of fwdSets)
        forwardLinks[k] = [...v];
    return {
        forwardLinks,
        backlinks: index.backlinks,
        brokenLinks: broken,
    };
}
/**
 * Entries with zero incoming and zero outgoing resolved links.
 * Virtual entries are excluded — they have no body and no `related`, and would
 * flood the list.
 */
export function detectOrphans(graph, entries) {
    const out = [];
    for (const d of entries) {
        if (d.source.kind === 'virtual')
            continue;
        const outgoing = graph.forwardLinks[d.id]?.length ?? 0;
        const incoming = graph.backlinks[d.id]?.length ?? 0;
        if (outgoing === 0 && incoming === 0)
            out.push(d.id);
    }
    return out;
}
export function detectHubs(graph, topN = 10) {
    const ranked = Object.entries(graph.backlinks)
        .map(([id, sources]) => ({ id, inDegree: sources.length }))
        .sort((a, b) => b.inDegree - a.inDegree || a.id.localeCompare(b.id));
    return ranked.slice(0, topN);
}
function isKgEntry(entry) {
    const vk = entry.ext?.virtualKind;
    return vk === 'kg-node' || vk === 'kg-layer' || vk === 'kg-tour-step';
}
/**
 * Heuristic health score: 100 minus weighted counts of broken links,
 * orphaned entries, and entries missing titles. Floored at 0.
 *
 * KG virtual entries are excluded from broken-link scoring so that
 * unresolved KG-internal references don't distort the wiki health metric.
 */
export function computeHealth(index, graph) {
    const orphans = detectOrphans(graph, index.entries);
    const hubs = detectHubs(graph, 10);
    const missingTitles = index.entries.filter((d) => d.source.kind === 'file' && (!d.title || d.title === d.id.split('-').slice(1).join('-'))).length;
    // Exclude broken links originating from KG virtual entries — their
    // internal cross-references are expected to be unresolvable as wiki IDs.
    const brokenLinks = graph.brokenLinks.filter(b => {
        const src = index.byId[b.sourceId];
        return !src || !isKgEntry(src);
    });
    const fileEntryCount = index.entries.filter(d => d.source.kind === 'file').length;
    const rawScore = 100 - 2 * brokenLinks.length - 1 * orphans.length - 3 * missingTitles;
    const score = Math.max(0, Math.min(100, rawScore));
    return {
        score,
        totals: {
            entries: fileEntryCount,
            brokenLinks: brokenLinks.length,
            orphans: orphans.length,
            missingTitles,
        },
        orphans,
        hubs,
        brokenLinks,
        lastUpdated: index.generatedAt,
    };
}
//# sourceMappingURL=graph-analysis.js.map