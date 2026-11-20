// Shared Arch-KB index and search primitives.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../config/paths.js';
let cachedIndex = null;
let indexLoaded = false;
/** Resolve bundled and installed Arch-KB resource directories. */
export function bundledArchKbResourceDirs() {
    const moduleDir = dirname(fileURLToPath(import.meta.url));
    return [
        resolve(moduleDir, '../../../resources/arch-kb'), // compiled: dist/src/arch-kb
        resolve(moduleDir, '../../resources/arch-kb'), // source: src/arch-kb
    ];
}
/** Find the first Arch-KB directory that contains an index. */
export function resolveArchKbIndexDir() {
    const candidates = [
        paths.archKb,
        ...bundledArchKbResourceDirs(),
        resolve(process.cwd(), 'resources/arch-kb'),
    ];
    return candidates.find((dir) => existsSync(join(dir, 'index.json'))) ?? null;
}
/** Load the read-only Arch-KB index, returning null when unavailable. */
export function loadArchKbIndex() {
    if (indexLoaded)
        return cachedIndex;
    const dir = resolveArchKbIndexDir();
    if (!dir)
        return null;
    try {
        cachedIndex = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf-8'));
        // Only pin the cache once we actually loaded an index. A missing index
        // (dir === null or read error) stays uncached so a long-lived process can
        // recover if the index appears later.
        indexLoaded = true;
    }
    catch {
        cachedIndex = null;
    }
    return cachedIndex;
}
/** Preserve the dedicated command's existing fail-loudly behavior. */
export function requireArchKbIndex() {
    const index = loadArchKbIndex();
    if (!index) {
        console.error('Error: arch-kb index not found. Run: node scripts/build-arch-kb-index.mjs');
        process.exit(1);
    }
    return index;
}
/** Resolve an indexed markdown path from installed, bundled, or source resources. */
export function resolveArchKbContentPath(relativePath) {
    const indexDir = resolveArchKbIndexDir();
    const candidates = [
        ...(indexDir ? [resolve(indexDir, relativePath)] : []),
        ...bundledArchKbResourceDirs().map((dir) => resolve(dir, relativePath)),
        resolve(process.cwd(), 'resources/arch-kb', relativePath),
        resolve(process.cwd(), '_analysis/awesome-architecture', relativePath),
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
export function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff-]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length > 0);
}
export function scoreArchKbEntry(entry, queryTokens) {
    let score = 0;
    let matched = false;
    const titleTokens = tokenize(entry.title);
    const keywordSet = new Set(entry.keywords.map(k => k.toLowerCase()));
    const sectionText = entry.sections.join(' ').toLowerCase();
    for (const queryToken of queryTokens) {
        if (keywordSet.has(queryToken)) {
            score += 10;
            matched = true;
        }
        else if (entry.keywords.some(keyword => keyword.toLowerCase().includes(queryToken) || queryToken.includes(keyword.toLowerCase()))) {
            score += 6;
            matched = true;
        }
        if (titleTokens.some(token => token.includes(queryToken) || queryToken.includes(token))) {
            score += 5;
            matched = true;
        }
        if (entry.slug.includes(queryToken)) {
            score += 4;
            matched = true;
        }
        if (entry.summary.toLowerCase().includes(queryToken)) {
            score += 2;
            matched = true;
        }
        if (sectionText.includes(queryToken)) {
            score += 1;
            matched = true;
        }
    }
    // Template bias only differentiates in the cross-type dedicated command
    // (`maestro arch-kb search` without --type); the mixed-search path
    // pre-filters to templates, where this boost is uniform and order-neutral.
    if (matched && entry.type === 'template')
        score += 1;
    return score;
}
export function searchArchKbEntriesWithScores(entries, query, opts = {}) {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0)
        return [];
    const filtered = opts.type ? entries.filter(entry => entry.type === opts.type) : entries;
    return filtered
        .map(entry => ({ entry, score: scoreArchKbEntry(entry, queryTokens) }))
        .filter(result => result.score > 0)
        .sort((left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id))
        .slice(0, opts.limit ?? 10);
}
export function searchArchKbEntries(entries, query, opts = {}) {
    return searchArchKbEntriesWithScores(entries, query, opts).map(result => result.entry);
}
export function searchArchKb(query, opts = {}) {
    const index = loadArchKbIndex();
    return index ? searchArchKbEntriesWithScores(index.entries, query, opts) : [];
}
export function resetArchKbIndexCache() {
    cachedIndex = null;
    indexLoaded = false;
}
//# sourceMappingURL=index.js.map