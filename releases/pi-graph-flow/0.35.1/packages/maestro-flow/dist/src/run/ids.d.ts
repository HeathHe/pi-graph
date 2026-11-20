/** Validate user-facing Session IDs before they can become filesystem paths. */
export declare function validateSessionId(value: string): void;
/** Reject non-portable filesystem path segments at the storage boundary. */
export declare function assertSafePathSegment(value: string, label: string): void;
//# sourceMappingURL=ids.d.ts.map