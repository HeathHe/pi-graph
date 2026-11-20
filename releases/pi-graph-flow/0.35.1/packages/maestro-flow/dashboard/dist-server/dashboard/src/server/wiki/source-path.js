import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const realpathCache = new Map();
const REALPATH_CACHE_MAX = 4096;
const MISSING = Symbol('realpath-missing');
function cachedRealpath(path) {
    const cached = realpathCache.get(path);
    if (cached === MISSING) {
        // Negative entry: only re-resolve once the path actually appears.
        try {
            lstatSync(path);
            realpathCache.delete(path);
        }
        catch {
            return null;
        }
    }
    else if (cached !== undefined) {
        try {
            const current = lstatSync(path);
            if (current.dev === cached.dev && current.ino === cached.ino) {
                return cached.real;
            }
            // Identity changed (replacement/symlink swap): fall through to a fresh
            // resolution.
        }
        catch {
            // Path disappeared — fall through to a fresh resolution which will
            // surface the failure through realpathSync.native.
        }
        realpathCache.delete(path);
    }
    let real;
    try {
        real = realpathSync.native(path);
    }
    catch {
        // Negative cache: the indexer probes many optional paths (e.g. a
        // workflow without a roadmap or glossary); realpathSync.native is ~1-3ms
        // per ENOENT attempt on Windows, which dominates the warm change-check
        // when repeated per query.
        if (realpathCache.size >= REALPATH_CACHE_MAX)
            realpathCache.clear();
        realpathCache.set(path, MISSING);
        return null;
    }
    if (realpathCache.size >= REALPATH_CACHE_MAX) {
        // Pathological breadth (e.g. a huge generated tree): drop everything
        // rather than keeping a lopsided cache. Re-population is just slow,
        // not incorrect.
        realpathCache.clear();
    }
    try {
        const current = lstatSync(path);
        if (!current.isSymbolicLink()) {
            realpathCache.set(path, { real, dev: current.dev, ino: current.ino });
        }
    }
    catch {
        // Nothing to cache — the path vanished between resolution and now.
    }
    return real;
}
function normalizeForComparison(path) {
    return process.platform === 'win32' ? path.toLowerCase() : path;
}
export function resolveAllowedSourcePathInfo(candidate, allowedRoot, kind = 'file') {
    try {
        const realRoot = cachedRealpath(resolve(allowedRoot));
        if (realRoot === null)
            return null;
        const realCandidate = cachedRealpath(resolve(candidate));
        if (realCandidate === null)
            return null;
        const comparedRoot = normalizeForComparison(realRoot);
        const comparedCandidate = normalizeForComparison(realCandidate);
        if (comparedCandidate !== comparedRoot
            && !comparedCandidate.startsWith(`${comparedRoot}${sep}`))
            return null;
        const sourceStat = statSync(realCandidate);
        if (kind === 'file' && !sourceStat.isFile())
            return null;
        if (kind === 'directory' && !sourceStat.isDirectory())
            return null;
        return { path: realCandidate, stat: sourceStat };
    }
    catch {
        return null;
    }
}
export function resolveAllowedSourcePath(candidate, allowedRoot, kind = 'file') {
    return resolveAllowedSourcePathInfo(candidate, allowedRoot, kind)?.path ?? null;
}
/**
 * Fast path for descendants of a root that was already realpath-resolved.
 * Symbolic links are rejected, so lexical containment cannot be redirected.
 */
export function resolveAllowedDirectSourcePathInfo(candidate, canonicalAllowedRoot, kind = 'file') {
    try {
        const requested = resolve(candidate);
        const realRoot = resolve(canonicalAllowedRoot);
        const comparedRoot = normalizeForComparison(realRoot);
        const comparedCandidate = normalizeForComparison(requested);
        if (comparedCandidate !== comparedRoot
            && !comparedCandidate.startsWith(`${comparedRoot}${sep}`))
            return null;
        const sourceStat = lstatSync(requested);
        if (sourceStat.isSymbolicLink())
            return null;
        if (kind === 'file' && !sourceStat.isFile())
            return null;
        if (kind === 'directory' && !sourceStat.isDirectory())
            return null;
        return { path: requested, stat: sourceStat };
    }
    catch {
        return null;
    }
}
export function resolveAllowedDirectSourcePath(candidate, canonicalAllowedRoot, kind = 'file') {
    return resolveAllowedDirectSourcePathInfo(candidate, canonicalAllowedRoot, kind)?.path ?? null;
}
export function isAllowedSourcePath(candidate, allowedRoot, kind = 'file') {
    return resolveAllowedSourcePath(candidate, allowedRoot, kind) !== null;
}
//# sourceMappingURL=source-path.js.map