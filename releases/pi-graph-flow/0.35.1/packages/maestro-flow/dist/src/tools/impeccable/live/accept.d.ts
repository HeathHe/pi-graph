interface AcceptOpts {
    id: string;
    variant?: number;
    discard?: boolean;
    paramValues?: string;
}
interface MarkerBlock {
    start: number;
    end: number;
}
interface CommentSyntax {
    open: string;
    close: string;
}
export declare function acceptCli(opts: AcceptOpts): Promise<void>;
/**
 * Find the start/end marker lines for a session.
 * Returns { start, end } (0-indexed line numbers) or null.
 */
export declare function findMarkerBlock(id: string, lines: string[]): MarkerBlock | null;
/**
 * Extract the original element content from within the variant wrapper.
 * Returns an array of lines.
 */
export declare function extractOriginal(lines: string[], block: MarkerBlock): string[];
/**
 * Extract a specific variant's inner content (stripping the wrapper div).
 * Returns an array of lines, or null if not found.
 */
export declare function extractVariant(lines: string[], block: MarkerBlock, variantNum: string): string[] | null;
/**
 * Extract the colocated <style> block content (between the style tags).
 * Returns an array of CSS lines, or null if no style block found.
 *
 * Handles three shapes of `<style data-impeccable-css="ID" ...>`:
 *   1. Self-closing: `<style ... />` — no body; return null (nothing to carbonize).
 *   2. Same-line open+close: `<style>...</style>` — return the inner content.
 *   3. Multi-line: `<style>` on one line, `</style>` on a later line — return
 *      the lines between them.
 */
export declare function extractCss(lines: string[], block: MarkerBlock, id: string): string[] | null;
/**
 * De-indent content that was indented by live-wrap.
 * The wrap script adds `indent + '    '` (4 extra spaces) to each line.
 * We restore to just `indent` level.
 */
export declare function deindentContent(contentLines: string[], baseIndent: string): string[];
export declare function detectCommentSyntax(filePath: string): CommentSyntax;
export {};
//# sourceMappingURL=accept.d.ts.map