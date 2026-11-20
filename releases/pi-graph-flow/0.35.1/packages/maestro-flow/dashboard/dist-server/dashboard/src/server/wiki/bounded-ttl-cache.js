/** Small in-process TTL/LRU cache for heavyweight derived data. */
export class BoundedTtlCache {
    maxEntries;
    ttlMs;
    now;
    entries = new Map();
    constructor(maxEntries, ttlMs, now = Date.now) {
        this.maxEntries = maxEntries;
        this.ttlMs = ttlMs;
        this.now = now;
        if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
            throw new Error('BoundedTtlCache maxEntries must be a positive integer');
        }
        if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
            throw new Error('BoundedTtlCache ttlMs must be positive');
        }
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return undefined;
        if (entry.expiresAt <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // Refresh insertion order without extending the expiry deadline.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }
    set(key, value) {
        const now = this.now();
        for (const [existingKey, entry] of this.entries) {
            if (entry.expiresAt <= now)
                this.entries.delete(existingKey);
        }
        this.entries.delete(key);
        this.entries.set(key, { value, expiresAt: now + this.ttlMs });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined)
                break;
            this.entries.delete(oldest);
        }
    }
    clear() {
        this.entries.clear();
    }
    get size() {
        return this.entries.size;
    }
}
//# sourceMappingURL=bounded-ttl-cache.js.map