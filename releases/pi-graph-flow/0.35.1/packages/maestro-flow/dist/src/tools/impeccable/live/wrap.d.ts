interface WrapOpts {
    id: string;
    count: number;
    elementId?: string;
    classes?: string;
    tag?: string;
    query?: string;
    file?: string;
    text?: string;
}
interface ElementMatch {
    startLine: number;
    endLine: number;
}
interface CommentSyntax {
    open: string;
    close: string;
}
export declare function wrapCli(opts: WrapOpts): Promise<void>;
/**
 * Build search query strings in priority order (most specific first).
 * ID is most reliable, then specific class combos, then single classes, then raw query.
 */
declare function buildSearchQueries(elementId?: string, classes?: string, tag?: string, query?: string): string[];
export declare function detectCommentSyntax(filePath: string): CommentSyntax;
export declare function findElement(lines: string[], query: string, tag?: string | null): ElementMatch | null;
/**
 * Starting from a line with an opening tag, find the line with the matching
 * closing tag by counting tag nesting depth.
 */
export declare function findClosingLine(lines: string[], start: number): number;
export { buildSearchQueries };
//# sourceMappingURL=wrap.d.ts.map