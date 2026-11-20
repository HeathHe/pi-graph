export declare const EXTERNAL_SURFACE_MANIFEST_SCHEMA_VERSION: "kg-external-surfaces/1.0";
export declare const EXTERNAL_SURFACE_MANIFEST_RELATIVE_PATH = ".workflow/kg/external-surfaces.json";
export declare const EXTERNAL_SURFACE_MAX_ENTRIES = 256;
export declare const EXTERNAL_SURFACE_MAX_FILE_SIZE: number;
export interface ExternalSurfaceManifestEntry {
    module: string;
    language: 'objc';
    path: string;
}
export interface ResolvedExternalSurfaceFile extends ExternalSurfaceManifestEntry {
    /** Canonical project-relative spelling from the manifest. */
    configuredPath: string;
    /** Exact real filesystem identity. */
    canonicalPath: string;
    size: number;
    modifiedAt: number;
    mtimeMs: number;
    device: number;
    inode: number;
}
export type ExternalSurfaceValidationErrorCode = 'config-not-regular-file' | 'config-outside-project' | 'config-too-large' | 'config-unreadable' | 'duplicate-canonical-file' | 'file-not-found' | 'file-identity-changed' | 'file-not-regular' | 'file-outside-project' | 'file-read-failed' | 'file-too-large' | 'invalid-json' | 'invalid-module' | 'invalid-path' | 'invalid-root' | 'missing-field' | 'too-many-files' | 'unknown-field' | 'unsafe-path' | 'unsupported-extension' | 'unsupported-language' | 'unsupported-schema-version';
export interface ExternalSurfaceValidationError {
    code: ExternalSurfaceValidationErrorCode;
    message: string;
    entryIndex?: number;
    path?: string;
}
export interface ExternalSurfaceManifestValidationResult {
    schemaVersion: typeof EXTERNAL_SURFACE_MANIFEST_SCHEMA_VERSION;
    configPath: string;
    configured: number;
    resolved: number;
    errors: ExternalSurfaceValidationError[];
    digest: string | null;
    files: ResolvedExternalSurfaceFile[];
}
export interface LoadedExternalSurfaceManifest {
    readonly schemaVersion: typeof EXTERNAL_SURFACE_MANIFEST_SCHEMA_VERSION;
    readonly configPath: string;
    readonly configured: number;
    readonly digest: string | null;
    readonly files: readonly ResolvedExternalSurfaceFile[];
}
/** A typed fail-closed error suitable for both extraction and CLI diagnostics. */
export declare class ExternalSurfaceManifestError extends Error {
    readonly detail: ExternalSurfaceValidationError;
    constructor(detail: ExternalSurfaceValidationError);
}
/** Aggregate raised by extraction when a configured manifest cannot be trusted. */
export declare class ExternalSurfaceManifestValidationFailure extends Error {
    readonly validation: ExternalSurfaceManifestValidationResult;
    constructor(validation: ExternalSurfaceManifestValidationResult);
}
export declare function getExternalSurfaceManifestPath(projectRoot: string): string;
/**
 * Resolve one exact entry without walking its parent or following imports.
 * This is the only filesystem bypass granted to ignored external headers.
 */
export declare function collectExactFile(projectRoot: string, value: unknown, entryIndex?: number): ResolvedExternalSurfaceFile;
/**
 * Read a previously collected exact file through a bound descriptor. The
 * identity and size checks close the pathname replacement window without ever
 * opening a directory, import target, or sibling.
 */
export declare function readExactFile(file: ResolvedExternalSurfaceFile): string;
/** Revalidates the collected descriptor identity without rereading content. */
export declare function verifyExactFileIdentity(file: ResolvedExternalSurfaceFile): void;
export interface PreparedExternalSurfaceFile {
    file: ResolvedExternalSurfaceFile;
    sourceCode: string;
    contentDigest: string;
}
export interface PreparedExternalSurfaceScan {
    manifest: LoadedExternalSurfaceManifest;
    files: readonly PreparedExternalSurfaceFile[];
    /** Manifest digest plus exact identity/content snapshot. */
    externalFingerprint: string;
}
/**
 * Captures the exact external bytes before a destructive transaction starts.
 * Extraction reuses these bytes instead of reopening the path, binding the
 * graph snapshot and sync watermark to one immutable input.
 */
export declare function prepareExternalSurfaceScan(projectRoot: string): PreparedExternalSurfaceScan;
/** Resolve an exact allowlist and reject canonical aliases of the same file. */
export declare function collectExactFiles(projectRoot: string, values: readonly unknown[]): ResolvedExternalSurfaceFile[];
/**
 * Validate the one fixed project carrier. Missing is intentionally equivalent
 * to an empty allowlist; every configured failure is returned as a typed error.
 */
export declare function validateExternalSurfaceManifest(projectRoot: string): ExternalSurfaceManifestValidationResult;
/** Strict extraction loader: any configured error aborts the caller. */
export declare function loadExternalSurfaceManifest(projectRoot: string): LoadedExternalSurfaceManifest;
