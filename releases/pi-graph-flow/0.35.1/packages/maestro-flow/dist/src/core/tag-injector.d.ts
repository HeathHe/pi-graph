import { type Manifest } from './manifest.js';
/** Default section name when none specified (backward compat). */
export declare const DEFAULT_SECTION = "core";
export declare function markerStart(section: string): string;
export declare function markerEnd(section: string): string;
/**
 * Detect whether the text contains markers for a specific section.
 */
export declare function hasSection(text: string, section: string): boolean;
/**
 * Detect whether the text contains any maestro markers at all.
 */
export declare function hasAnyMarkers(text: string): boolean;
/**
 * Compute bidirectional line-level similarity (Jaccard-like).
 * Returns 0..1 where 1 = existing and source have identical line sets.
 * Uses intersection / union to avoid false positives when one is a superset.
 */
export declare function computeSimilarity(existing: string, source: string): number;
export type MigrateAction = 'created' | 'updated' | 'migrated' | 'injected';
export interface MigrateResult {
    /** What action was taken */
    action: MigrateAction;
    /** Final file content */
    content: string;
    /** Warning message for user (legacy content needs manual cleanup) */
    warning?: string;
}
/**
 * Migrate legacy or update existing doc file content with section-based tag injection.
 *
 * Handles scenarios:
 * 1. No existing file        → create with markers (`created`)
 * 2. Has this section        → replace between markers (`updated`)
 * 3. Legacy ≥99% similar (core section only, no markers at all) → replace entire content (`migrated`)
 * 4. Legacy ≥80% similar (core section only) → inject + warn (`injected` + warning)
 * 5. Otherwise               → append markers normally (`injected`)
 */
export declare function migrateAndInject(existingContent: string, sourceContent: string, targetPath: string, section?: string): MigrateResult;
/**
 * Inject or update content for a specific section.
 *
 * - If section markers exist, replaces everything between them.
 * - If no section markers, appends section block at the end.
 * - If the file is empty/missing, creates with section block.
 *
 * Returns the updated text.
 */
export declare function injectContent(existingContent: string, content: string, section?: string): string;
/**
 * Remove a specific section's markers and content.
 * Returns the cleaned text, or the original text if section not found.
 */
export declare function removeContent(text: string, section?: string): string;
/**
 * Remove ALL maestro sections from text.
 * Also cleans up any orphaned markers (start without matching end).
 */
export declare function removeAllSections(text: string): string;
export interface CopyStats {
    files: number;
    dirs: number;
    skipped: number;
}
/**
 * Inject source content into a target doc file using sectioned markers.
 * Handles legacy migration with similarity detection.
 *
 * Returns migration result with optional warning.
 */
export declare function injectDocFile(src: string, dest: string, stats: CopyStats, manifest: Manifest, section?: string): MigrateResult;
//# sourceMappingURL=tag-injector.d.ts.map