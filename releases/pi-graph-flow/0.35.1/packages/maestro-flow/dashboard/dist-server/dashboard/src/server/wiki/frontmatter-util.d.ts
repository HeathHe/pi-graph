export interface ParsedFrontmatter {
    data: Record<string, unknown>;
    content: string;
}
export declare function parseFrontmatter(raw: string): ParsedFrontmatter;
