export declare function assertValidCritiqueSlug(slug: string): void;
export declare function slugFromTarget(resolved: string | null | undefined, { cwd }?: {
    cwd?: string;
}): string | null;
export declare function nowFilenameStamp(date?: Date): string;
export interface SnapshotMeta {
    [key: string]: string | number | boolean | null | undefined;
}
export interface WriteSnapshotOptions {
    slug: string;
    meta?: SnapshotMeta;
    body: string;
    cwd?: string;
    now?: Date;
}
export declare function writeSnapshot(opts: WriteSnapshotOptions): string;
export interface LatestSnapshot {
    path: string;
    body: string;
    meta: Record<string, string | number>;
}
export declare function readLatestSnapshot(slug: string, { cwd }?: {
    cwd?: string;
}): LatestSnapshot | null;
export declare function readTrend(slug: string, { limit, cwd }?: {
    limit?: number;
    cwd?: string;
}): Record<string, string | number>[];
//# sourceMappingURL=critique-storage.d.ts.map