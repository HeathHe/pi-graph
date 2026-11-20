/**
 * Shared file reading utilities
 *
 * Extracted from read-file.ts for reuse across read_file and read_many_files tools.
 */
export declare const MAX_CONTENT_LENGTH = 5000;
export declare const MAX_FILES = 50;
export declare const MAX_TOTAL_CONTENT = 50000;
export declare const BINARY_EXTENSIONS: Set<string>;
export interface FileEntry {
    path: string;
    size: number;
    content?: string;
    truncated?: boolean;
    matches?: string[];
    totalLines?: number;
    lineRange?: {
        start: number;
        end: number;
    };
}
export interface ReadContentOptions {
    maxLength: number;
    offset?: number;
    limit?: number;
}
export interface ReadContentResult {
    content: string;
    truncated: boolean;
    totalLines?: number;
    lineRange?: {
        start: number;
        end: number;
    };
}
export interface ReadResult {
    files: FileEntry[];
    totalFiles: number;
    message: string;
}
/**
 * Check if file is likely binary
 */
export declare function isBinaryFile(filePath: string): boolean;
/**
 * Convert glob pattern to regex
 * Supports: *, ?, and brace expansion {a,b,c}
 */
export declare function globToRegex(pattern: string): RegExp;
/**
 * Check if filename matches glob pattern
 */
export declare function matchesPattern(filename: string, pattern: string): boolean;
/**
 * Recursively collect files from directory
 */
export declare function collectFiles(dir: string, pattern: string | undefined, maxDepth: number, currentDepth?: number): string[];
/**
 * Read file content with truncation and optional line-based pagination
 */
export declare function readFileContent(filePath: string, options: ReadContentOptions): ReadContentResult;
/**
 * Find regex matches in content with safety protections
 * - Empty string pattern = "match all" (no filtering) - returns null
 * - Dangerous patterns (zero-width matches) = "match all" for safety - returns null
 * - Validates pattern to prevent infinite loops
 * - Limits iterations to prevent ReDoS attacks
 * - Deduplicates results to prevent duplicates
 * - Reports errors instead of silent failure
 *
 * @returns Array of matching lines, null to match all content (empty string or dangerous pattern), empty array for no matches
 */
export declare function findMatches(content: string, pattern: string): string[] | null;
//# sourceMappingURL=file-reader.d.ts.map