import { type OverlayMeta, type OverlayManifest } from './types.js';
export declare function loadOverlayManifest(scope: 'global' | 'project', targetBase: string): OverlayManifest | null;
export declare function deleteOverlayManifest(scope: 'global' | 'project', targetBase: string): void;
export interface ApplyOptions {
    /** Root dir where `.claude/commands/` and `.codex/skills/` live (homedir for global, project dir for project). */
    targetBase: string;
    scope: 'global' | 'project';
    /** Directory containing overlay JSON files (usually `~/.maestro/overlays/`). */
    overlayDir: string;
    /** Optional logger; defaults to console.error. */
    logger?: (msg: string) => void;
}
export interface ApplyReport {
    manifest: OverlayManifest;
    manifestPath: string;
    overlaysLoaded: number;
    overlaysApplied: number;
    filesChanged: number;
    filesUnchanged: number;
    loadErrors: {
        path: string;
        errors: string[];
    }[];
    skipped: {
        overlay: string;
        target: string;
        reason: string;
    }[];
}
export declare function applyOverlays(opts: ApplyOptions): ApplyReport;
export interface RemoveResult {
    targetsCleaned: number;
    filesChanged: number;
}
/**
 * Remove all marker blocks for the given overlay name from every target
 * command file recorded in the overlay manifest. Updates the manifest.
 */
export declare function removeOverlayFromTargets(overlayName: string, scope: 'global' | 'project', targetBase: string): RemoveResult;
export declare function ensureOverlayDir(overlayDir: string): void;
export interface ExportResult {
    /** Source overlay file inside overlayDir. */
    source: string;
    /** Destination path the file was written to. */
    dest: string;
    overlayName: string;
}
/**
 * Export an overlay by name from `overlayDir` to `outPath`.
 *
 * - If `outPath` is a directory, writes `<name>.json` inside it.
 * - If `outPath` is a file path, writes verbatim (overwriting if present).
 * - Throws if the overlay name is not found in `overlayDir`.
 */
export declare function exportOverlayFile(overlayDir: string, name: string, outPath: string): ExportResult;
export interface ImportResult {
    /** Source file the caller provided. */
    source: string;
    /** Destination path inside `overlayDir`. */
    dest: string;
    overlayName: string;
    /** True if the destination already existed and was overwritten. */
    overwritten: boolean;
}
/**
 * Import an overlay JSON file into `overlayDir`. Validates before copy and
 * throws if the file is not a valid overlay. Returns the destination path.
 *
 * Does not auto-apply — callers that want immediate effect should invoke
 * `applyOverlays` afterwards.
 */
export declare function importOverlayFile(srcPath: string, overlayDir: string): ImportResult;
export interface OverlayBundle {
    version: '1.0';
    overlays: OverlayMeta[];
    /** Relative path → file content for docs referenced by overlays. */
    docs: Record<string, string>;
    /** UID of the team member who created this bundle (team sync). */
    sourceMember?: string;
    /** ISO 8601 timestamp of bundle creation (team sync). */
    ts?: string;
}
export interface BundleResult {
    dest: string;
    overlayCount: number;
    docCount: number;
}
/**
 * Bundle all (or selected) overlays from `overlayDir` into a single JSON file.
 * Includes any files under `overlayDir/docs/` that are referenced by overlay
 * patch content via `@~/.maestro/overlays/docs/` paths.
 */
export declare function bundleOverlays(overlayDir: string, outPath: string, names?: string[]): BundleResult;
export interface ImportBundleItem {
    name: string;
    overwritten: boolean;
}
export interface ImportBundleResult {
    source: string;
    items: ImportBundleItem[];
    docsWritten: number;
}
/**
 * Import a bundle file, writing each overlay as an individual JSON file into
 * `overlayDir` and restoring any bundled docs into `overlayDir/docs/`.
 */
export declare function importBundle(bundlePath: string, overlayDir: string): ImportBundleResult;
//# sourceMappingURL=applier.d.ts.map