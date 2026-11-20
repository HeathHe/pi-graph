export interface AsyncClosable {
    close(): Promise<void>;
}
/**
 * Serializes use and replacement of one keyed async resource.
 * A superseded resource is closed only after its current borrower finishes.
 */
export declare class AsyncResourceSlot<K, R extends AsyncClosable> {
    private current;
    private tail;
    run<T>(key: K, create: () => Promise<R>, use: (resource: R) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
//# sourceMappingURL=async-resource-slot.d.ts.map