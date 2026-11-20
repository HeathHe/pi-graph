/**
 * MOA reference result cache — disk-backed with TTL.
 *
 * Reference agent outputs are deterministic enough to cache per
 * (prompt, cwd, endpoint, model). Cached entries live under
 * .workflow/explore/.moa-cache and expire after ttlMs.
 */
import type { ReferenceOutput } from './moa-loop.js';
export declare function computeCacheKey(prompt: string, cwd: string, endpointName: string, model: string, stepIndex?: number): string;
export declare function readCache(cwd: string, key: string, ttlMs?: number): ReferenceOutput | null;
export declare function writeCache(cwd: string, key: string, output: ReferenceOutput, prompt: string, endpointName: string, model: string, ttlMs?: number): void;
//# sourceMappingURL=moa-cache.d.ts.map