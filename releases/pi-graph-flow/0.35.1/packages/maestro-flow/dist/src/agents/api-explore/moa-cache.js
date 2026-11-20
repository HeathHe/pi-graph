/**
 * MOA reference result cache — disk-backed with TTL.
 *
 * Reference agent outputs are deterministic enough to cache per
 * (prompt, cwd, endpoint, model). Cached entries live under
 * .workflow/explore/.moa-cache and expire after ttlMs.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const DEFAULT_TTL_MS = 3_600_000; // 1 hour
function cacheDir(cwd) {
    return join(cwd, '.workflow', 'explore', '.moa-cache');
}
export function computeCacheKey(prompt, cwd, endpointName, model, stepIndex) {
    const parts = `${prompt}\0${cwd}\0${endpointName}\0${model}`;
    return createHash('sha256')
        .update(stepIndex != null ? `${parts}\0step${stepIndex}` : parts)
        .digest('hex');
}
export function readCache(cwd, key, ttlMs = DEFAULT_TTL_MS) {
    const filePath = join(cacheDir(cwd), `${key}.json`);
    if (!existsSync(filePath))
        return null;
    try {
        const entry = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (Date.now() - entry.timestamp > ttlMs)
            return null; // expired
        return entry.output;
    }
    catch {
        return null;
    }
}
export function writeCache(cwd, key, output, prompt, endpointName, model, ttlMs = DEFAULT_TTL_MS) {
    const dir = cacheDir(cwd);
    mkdirSync(dir, { recursive: true });
    const entry = {
        key,
        prompt,
        cwd,
        endpointName,
        model,
        timestamp: Date.now(),
        ttlMs,
        output,
    };
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry, null, 2), 'utf-8');
}
//# sourceMappingURL=moa-cache.js.map