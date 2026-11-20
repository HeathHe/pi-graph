import { type Stats } from 'node:fs';
export type AllowedSourceKind = 'file' | 'directory' | 'any';
/**
 * Resolve an existing source through symlinks and prove that it remains under
 * an explicitly allowed root. Callers must use the returned real path for I/O.
 */
export interface AllowedSourcePathInfo {
    path: string;
    stat: Stats;
}
export declare function resolveAllowedSourcePathInfo(candidate: string, allowedRoot: string, kind?: AllowedSourceKind): AllowedSourcePathInfo | null;
export declare function resolveAllowedSourcePath(candidate: string, allowedRoot: string, kind?: AllowedSourceKind): string | null;
/**
 * Fast path for descendants of a root that was already realpath-resolved.
 * Symbolic links are rejected, so lexical containment cannot be redirected.
 */
export declare function resolveAllowedDirectSourcePathInfo(candidate: string, canonicalAllowedRoot: string, kind?: AllowedSourceKind): AllowedSourcePathInfo | null;
export declare function resolveAllowedDirectSourcePath(candidate: string, canonicalAllowedRoot: string, kind?: AllowedSourceKind): string | null;
export declare function isAllowedSourcePath(candidate: string, allowedRoot: string, kind?: AllowedSourceKind): boolean;
