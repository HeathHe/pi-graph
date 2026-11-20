import type { WikiEntry } from './wiki-types.js';
/**
 * Source families that can be updated without projecting the complete wiki.
 * `unsupported` is deliberately retained in the manifest: a change to an
 * unknown/session/KG/transcript-shaped file must never be mistaken for a safe
 * incremental update.
 */
export type IncrementalSourceKind = 'project' | 'spec' | 'knowhow' | 'domain' | 'issue' | 'doc' | 'unsupported';
export type CoveredSourceKind = Exclude<IncrementalSourceKind, 'unsupported'>;
export declare const SOURCE_MANIFEST_VERSION = 1;
export declare const SOURCE_MANIFEST_FILE = "wiki-source-manifest.json";
/** A normalized, content-addressed local source record. */
export interface SourceManifestEntry {
    /** Forward-slash path relative to the indexed workflow root. */
    path: string;
    sourceKind: IncrementalSourceKind;
    size: number;
    mtimeMs: number;
    contentHash: string;
    /** IDs emitted by the source parser in the published generation. */
    entryIds: string[];
}
export interface SourceManifest {
    version: typeof SOURCE_MANIFEST_VERSION;
    /** Absolute root identity. It is validation metadata, not part of the content fingerprint. */
    root: string;
    generation: number;
    entries: SourceManifestEntry[];
    /** SHA-256 over normalized path/kind/stat/hash tuples. */
    sourceFingerprint: string;
}
export type SourceChangeKind = 'add' | 'modify' | 'delete' | 'rename';
export interface SourceChange {
    kind: SourceChangeKind;
    path: string;
    sourceKind: IncrementalSourceKind;
    previousPath?: string;
    previous?: SourceManifestEntry;
    current?: SourceManifestEntry;
}
export interface BuildSourceManifestOptions {
    /** Include unknown files as `unsupported` (default true for safe fencing). */
    includeUnsupported?: boolean;
    /** Optional generation associated with the manifest. */
    generation?: number;
    /** Abort while walking/reading a large source tree. */
    signal?: AbortSignal;
    /** IDs from a just-built index, keyed by normalized source path. */
    entryIdsByPath?: ReadonlyMap<string, readonly string[]>;
}
export declare function throwIfManifestAborted(signal?: AbortSignal): void;
/** Normalize a relative source path for deterministic comparison/persistence. */
export declare function normalizeManifestPath(path: string, root?: string): string;
/** Compatibility alias for callers that use the shorter name. */
export declare const normalizeSourcePath: typeof normalizeManifestPath;
/** Classify only the file families understood by WikiIndexer incremental mode. */
export declare function classifySourcePath(path: string): IncrementalSourceKind;
export declare function isCoveredSourceKind(kind: IncrementalSourceKind): kind is CoveredSourceKind;
export declare function sourceManifestFingerprint(manifest: Pick<SourceManifest, 'entries'>): string;
/**
 * Build a deterministic manifest for files below `root`.
 *
 * Symlinks are not followed. Unknown files are retained as unsupported fences
 * by default so additions to sessions/KG/transcripts/configuration cannot be
 * silently accepted by the incremental path.
 */
export declare function buildSourceManifest(root: string, options?: BuildSourceManifestOptions): Promise<SourceManifest>;
/** Compatibility alias for the scanner-oriented name. */
export declare const createSourceManifest: typeof buildSourceManifest;
export declare const scanSourceManifest: typeof buildSourceManifest;
/** Return true when only source content/stat metadata is equal (entry IDs ignored). */
export declare function sourceManifestsContentEqual(left: Pick<SourceManifest, 'entries'>, right: Pick<SourceManifest, 'entries'>): boolean;
/**
 * Compute add/modify/delete/rename operations. Renames are paired by source
 * kind and content hash, with lexical path tie-breaking for deterministic
 * behavior when duplicate files have the same bytes.
 */
export declare function diffSourceManifests(previous: Pick<SourceManifest, 'entries'>, current: Pick<SourceManifest, 'entries'>): SourceChange[];
export declare const diffManifests: typeof diffSourceManifests;
export declare function manifestEntryForPath(manifest: Pick<SourceManifest, 'entries'>, path: string): SourceManifestEntry | undefined;
/** Attach final entry IDs to a manifest without changing source metadata. */
export declare function manifestWithEntryIds(manifest: SourceManifest, entries: readonly WikiEntry[]): SourceManifest;
/** Validate untrusted persisted data; invalid manifests are cache misses. */
export declare function validateSourceManifest(value: unknown, expectedRoot?: string): SourceManifest | null;
export declare function readSourceManifest(path: string, expectedRoot?: string, signal?: AbortSignal): Promise<SourceManifest | null>;
/** Atomically persist a manifest. The caller still owns generation fencing. */
export declare function writeSourceManifest(path: string, manifest: SourceManifest, signal?: AbortSignal): Promise<string>;
/** Compare persisted IDs as well as source metadata for publication validation. */
export declare function sourceManifestsEqual(left: Pick<SourceManifest, 'entries'>, right: Pick<SourceManifest, 'entries'>): boolean;
