export interface SectionSpan {
    name: string;
    /** Line index of the opening `<name>` tag (0-based). */
    openLine: number;
    /** Line index of the closing `</name>` tag (0-based). */
    closeLine: number;
}
export interface ParsedFile {
    /** Array of lines (no trailing `\n`). */
    lines: string[];
    /** Detected end-of-line used in the original file (`\n` or `\r\n`). */
    eol: '\n' | '\r\n';
    /** Line index of `---` opening frontmatter, or -1. */
    frontmatterStart: number;
    /** Line index of `---` closing frontmatter, or -1. */
    frontmatterEnd: number;
    sections: SectionSpan[];
}
export declare function detectEol(text: string): '\n' | '\r\n';
export declare function splitLines(text: string): string[];
export declare function joinLines(lines: string[], eol: '\n' | '\r\n'): string;
export declare function parseSections(text: string): ParsedFile;
/** Find a section by name. Returns the first occurrence or undefined. */
export declare function findSection(parsed: ParsedFile, name: string): SectionSpan | undefined;
//# sourceMappingURL=section-parser.d.ts.map