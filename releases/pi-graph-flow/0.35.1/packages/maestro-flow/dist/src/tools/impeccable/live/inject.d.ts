interface InjectOpts {
    port?: string;
    remove?: boolean;
    check?: boolean;
}
export interface LiveConfig {
    files: string[];
    exclude?: string[];
    insertBefore?: string;
    insertAfter?: string;
    commentSyntax: 'html' | 'jsx';
    cspChecked?: boolean;
}
export declare function injectCli(opts?: InjectOpts): Promise<void>;
/**
 * Expand config.files (which may contain glob patterns) into a literal list
 * of existing file paths relative to rootDir. Literal entries pass through;
 * glob patterns are expanded via fs.globSync. HARD_EXCLUDES and config.exclude
 * are applied as filters. Duplicates are removed. Order is preserved by
 * first appearance.
 */
export declare function resolveFiles(rootDir: string, config: LiveConfig): string[];
declare function validateConfig(cfg: LiveConfig): void;
export declare function buildTagBlock(syntax: string, port: number): string;
export declare function insertTag(content: string, config: LiveConfig, port: number): string;
/**
 * Remove the live script block. Matches either HTML or JSX comment markers
 * regardless of config (so stale tags from a wrong config can still be cleaned).
 *
 * Indent-preserving: captures any whitespace immediately preceding the opener
 * marker and re-emits it in place of the removed block. `insertTag` inserted
 * the block *after* the original line's indent and *before* the anchor (e.g.
 * `</body>`), which moved the indent onto the opener line and left the anchor
 * unindented. Replacing the whole block (plus its trailing newline) with just
 * the captured indent hands the indent back to the anchor that follows.
 */
export declare function removeTag(content: string, _syntax: string): string;
export declare function patchCspMeta(content: string, port: number): string;
export declare function revertCspMeta(content: string): string;
export { validateConfig };
//# sourceMappingURL=inject.d.ts.map