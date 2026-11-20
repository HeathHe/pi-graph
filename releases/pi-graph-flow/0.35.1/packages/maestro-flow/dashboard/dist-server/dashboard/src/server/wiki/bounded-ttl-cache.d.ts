/** Small in-process TTL/LRU cache for heavyweight derived data. */
export declare class BoundedTtlCache<K, V> {
    private readonly maxEntries;
    private readonly ttlMs;
    private readonly now;
    private readonly entries;
    constructor(maxEntries: number, ttlMs: number, now?: () => number);
    get(key: K): V | undefined;
    set(key: K, value: V): void;
    clear(): void;
    get size(): number;
}
