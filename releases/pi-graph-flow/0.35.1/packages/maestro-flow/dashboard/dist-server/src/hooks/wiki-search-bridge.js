/**
 * Wiki Search Bridge — hot-path helper for keyword spec injection.
 *
 * Provides a best-effort wiki search that never throws: tries the resident
 * search daemon first (no heavy imports), falls back to a lazily-loaded
 * WikiIndexer BM25 search. Results are filtered to spec + knowhow entries,
 * score-thresholded, and capped.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncResourceSlot } from '../utils/async-resource-slot.js';
import { isDeprecatedKnowledgeEntry } from '../utils/knowledge-lifecycle.js';
import { loadWorkspaceConfig, resolveWorkspaceLinks } from '../config/index.js';
import { resolveRepositoryContext } from '../repository/context.js';
const ALLOWED_TYPES = new Set(['spec', 'knowhow']);
const INTERNAL_LIMIT = 10;
const DEFAULT_LIMIT = 3;
const DEFAULT_MIN_SCORE = 1.0;
/**
 * Daemon budget — also the total budget of this call whenever a daemon is live.
 * Measured daemon latency is 220-305ms idle and 470-1870ms under load, so this
 * leaves ~2x headroom over the idle case while keeping the worst case bounded
 * well inside an interactive hook. Missing it yields no context, which is the
 * correct trade on a prompt hot path: a wider budget would just move seconds of
 * stall from the fallback into the wait.
 */
const DEFAULT_HOOK_DAEMON_TIMEOUT_MS = 700;
/**
 * Pathological-hang guard for the cold in-process indexer, which parses ~11MB of
 * index JSON and legitimately needs ~2s. It only runs when no daemon is live, so
 * it is the sole content source on that path and is not held to the hook budget.
 */
const DEFAULT_INDEXER_TIMEOUT_MS = 3000;
/** Hybrid mode: keep hits scoring at least this fraction of the top hit. */
const HYBRID_RELATIVE_FACTOR = 0.4;
/** Scale heuristic: hybrid scores are ≤ ~1.2 while BM25 raw scores run far higher. */
const HYBRID_SCALE_CUTOFF = 1.5;
// --- Cached WikiIndexer (lazy, only loaded when daemon is unavailable) ---
const indexerSlot = new AsyncResourceSlot();
function resolveWikiAuthority(workflowRoot) {
    const projectRoot = join(workflowRoot, '..');
    const current = resolveRepositoryContext('current', { projectRoot });
    const linkedWorkspaces = resolveWorkspaceLinks(projectRoot, loadWorkspaceConfig(projectRoot))
        .filter(link => link.valid)
        .map(link => ({
        name: link.name,
        workflowRoot: link.workflowRoot,
        shareTypes: link.share,
        repoId: link.repoId,
        repoName: link.repoName,
        workspaceFence: link.repoId ? `repo:${link.repoId}` : `linked:${link.name}`,
    }));
    const repository = {
        repoId: current.repoId,
        repoName: current.repoName,
        alias: current.alias,
        workspaceFence: current.repoId ? `repo:${current.repoId}` : undefined,
    };
    return {
        linkedWorkspaces,
        repository,
        authorityKey: JSON.stringify({ linkedWorkspaces, repository }),
    };
}
async function withIndexer(workflowRoot, operation) {
    const { linkedWorkspaces, repository, authorityKey } = resolveWikiAuthority(workflowRoot);
    const key = JSON.stringify({ workflowRoot, authorityKey });
    return indexerSlot.run(key, async () => {
        const { WikiIndexer: Cls } = await import('#maestro-dashboard/wiki/wiki-indexer.js');
        return new Cls({
            workflowRoot,
            linkedWorkspaces,
            repository,
            role: 'reader',
        });
    }, operation);
}
/**
 * Resolve the score threshold for a daemon response.
 *
 * Scale decides, not mode. The absolute default only means anything against raw
 * BM25 magnitudes, which commonly exceed 5; a normalized response needs a cut
 * relative to its own top score.
 *
 * This used to read `embeddingUsed ?? top < HYBRID_SCALE_CUTOFF`, which made the
 * scale heuristic dead code whenever the daemon answered at all — it always
 * reports the flag. The hook always asks with `skipEmbedding`, so the flag came
 * back false, the absolute 1.0 was applied, and every hit was dropped: measured
 * across 4 queries × BM25-only and hybrid, daemon top scores were 0.893-0.996 and
 * `>= 1.0` left 0 of 9-10 typed hits every time. The daemon normalizes BM25-only
 * responses too, so `embeddingUsed` was never the right signal.
 */
function adaptiveMinScore(raw, embeddingUsed) {
    const top = raw.reduce((m, r) => Math.max(m, r.score), 0);
    if (top <= 0)
        return DEFAULT_MIN_SCORE;
    const normalized = top < HYBRID_SCALE_CUTOFF || embeddingUsed === true;
    return normalized ? HYBRID_RELATIVE_FACTOR * top : DEFAULT_MIN_SCORE;
}
function isApplicable(entry, targetRepoId) {
    const appliesToRepoIds = entry.appliesToRepoIds ?? entry.ext?.appliesToRepoIds;
    if (appliesToRepoIds === undefined || appliesToRepoIds === null)
        return true;
    if (targetRepoId === undefined)
        return true;
    return targetRepoId !== null && appliesToRepoIds.includes(targetRepoId);
}
function toHits(raw, limit, minScore, applicableRepoId) {
    return raw
        .filter((r) => ALLOWED_TYPES.has(r.entry.type)
        && !isDeprecatedKnowledgeEntry(r.entry)
        && isApplicable(r.entry, applicableRepoId)
        && r.score >= minScore)
        .slice(0, limit)
        .map((r) => ({
        id: r.entry.id,
        type: r.entry.type,
        title: r.entry.title || 'Untitled',
        summary: (r.entry.summary || '').slice(0, 200),
        score: r.score,
    }));
}
function hasPersistedSearchIndex(workflowRoot) {
    return existsSync(join(workflowRoot, 'search-cache.json'))
        || existsSync(join(workflowRoot, 'wiki-index.json'));
}
/**
 * Search the wiki knowledge base. Best-effort — never throws.
 * Returns filtered spec + knowhow hits and the source that produced them.
 */
export async function searchWiki(workflowRoot, query, opts) {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const daemonTimeoutMs = opts?.daemonTimeoutMs ?? DEFAULT_HOOK_DAEMON_TIMEOUT_MS;
    const skipEmbedding = opts?.skipEmbedding ?? true;
    try {
        let authorityKey;
        try {
            authorityKey = resolveWikiAuthority(workflowRoot).authorityKey;
        }
        catch {
            // Tests and other callers may not have a real workspace to resolve.
        }
        // Fast path: try search daemon (no heavy imports)
        let daemonLive = false;
        try {
            const { tryDaemonSearch, readDaemonInfo, isDaemonAlive } = await import('../search/daemon-client.js');
            const info = readDaemonInfo(workflowRoot);
            daemonLive = !!info && isDaemonAlive(info);
            const daemonResult = await tryDaemonSearch(workflowRoot, query, INTERNAL_LIMIT, skipEmbedding, {
                timeoutMs: daemonTimeoutMs,
                filters: { applicableRepoId: opts?.applicableRepoId ?? '__legacy__' },
                ...(authorityKey !== undefined ? { authorityKey } : {}),
            });
            if (daemonResult?.ok && daemonResult.results) {
                const raw = daemonResult.results;
                const minScore = opts?.minScore ?? adaptiveMinScore(raw, daemonResult.embeddingUsed);
                return { hits: toHits(raw, limit, minScore, opts?.applicableRepoId), source: 'daemon' };
            }
        }
        catch {
            // Daemon unavailable — fall through to direct search
        }
        // A live daemon owns the same index the local indexer would rebuild. When it
        // is up but did not answer in time, spending seconds to duplicate its work
        // in-process is the worst outcome for an interactive hook — degrade to empty
        // instead. The fallback exists for the daemon-absent case only.
        if (daemonLive) {
            return { hits: [], source: 'none' };
        }
        if (!hasPersistedSearchIndex(workflowRoot)) {
            return { hits: [], source: 'none' };
        }
        // Fallback: direct WikiIndexer BM25 search (skipEmbedding → raw BM25 scale).
        // Bounded — a cold process parses ~11MB of index JSON, so this must never be
        // allowed to run unmetered on the prompt hot path.
        const results = await withTimeout(withIndexer(workflowRoot, indexer => indexer.searchWithMeta(query, INTERNAL_LIMIT, {
            skipEmbedding: true,
            filters: { applicableRepoId: opts?.applicableRepoId ?? '__legacy__' },
        }).then(r => r.results)), DEFAULT_INDEXER_TIMEOUT_MS);
        if (!results)
            return { hits: [], source: 'none' };
        const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;
        return { hits: toHits(results, limit, minScore, opts?.applicableRepoId), source: 'indexer' };
    }
    catch {
        return { hits: [], source: 'none' };
    }
}
/** Resolve to null if the promise does not settle within `ms`. */
function withTimeout(p, ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);
        if (typeof timer.unref === 'function')
            timer.unref();
        p.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
    });
}
/**
 * Fire-and-forget background init of the WikiIndexer so future searches
 * skip the cold-start cost. Never throws.
 */
export function prewarmWikiIndexer(workflowRoot) {
    withIndexer(workflowRoot, indexer => indexer.get().then(() => undefined)).catch(() => { });
}
//# sourceMappingURL=wiki-search-bridge.js.map