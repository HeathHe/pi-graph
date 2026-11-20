/**
 * Read Many Files Tool - Multi-file batch reading with directory traversal and content search
 *
 * Features:
 * - Read multiple files at once
 * - Read all files in a directory (with depth control)
 * - Filter files by glob pattern
 * - Content search with regex
 * - Compact output format
 */
import { z } from 'zod';
import { existsSync, statSync } from 'fs';
import { relative } from 'path';
import { validatePath, getProjectRoot } from '../utils/path-validator.js';
import { MAX_CONTENT_LENGTH, MAX_FILES, MAX_TOTAL_CONTENT, collectFiles, matchesPattern, readFileContent, findMatches, } from '../utils/file-reader.js';
const ParamsSchema = z.object({
    paths: z.union([z.string(), z.array(z.string())]).describe('File path(s) or directory'),
    pattern: z.string().optional().describe('Glob pattern to filter files (e.g., "*.ts", "**/*.js")'),
    contentPattern: z.string().optional().describe('Regex to search within file content'),
    maxDepth: z.number().default(3).describe('Max directory depth to traverse'),
    includeContent: z.boolean().default(true).describe('Include file content in result'),
    maxFiles: z.number().default(MAX_FILES).describe('Max number of files to return'),
});
export const schema = {
    name: 'read_many_files',
    description: `Read multiple files, directories, or search file content with regex.

Usage:
  read_many_files(paths=["a.ts", "b.ts"])                  # Multiple files
  read_many_files(paths="src/", pattern="*.ts")             # Directory with glob filter
  read_many_files(paths="src/", contentPattern="TODO")      # Search content with regex
  read_many_files(paths="src/", pattern="*.ts", includeContent=false)  # List files only

Supports both absolute and relative paths. Relative paths are resolved from project root.`,
    inputSchema: {
        type: 'object',
        properties: {
            paths: {
                oneOf: [
                    { type: 'string', description: 'Single file or directory path' },
                    { type: 'array', items: { type: 'string' }, description: 'Array of file paths' },
                ],
                description: 'File path(s) or directory to read',
            },
            pattern: {
                type: 'string',
                description: 'Glob pattern to filter files (e.g., "*.ts", "*.{js,ts}")',
            },
            contentPattern: {
                type: 'string',
                description: 'Regex pattern to search within file content',
            },
            maxDepth: {
                type: 'number',
                description: 'Max directory depth to traverse (default: 3)',
                default: 3,
            },
            includeContent: {
                type: 'boolean',
                description: 'Include file content in result (default: true)',
                default: true,
            },
            maxFiles: {
                type: 'number',
                description: `Max number of files to return (default: ${MAX_FILES})`,
                default: MAX_FILES,
            },
        },
        required: ['paths'],
    },
};
export async function handler(params) {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
        return { success: false, error: `Invalid params: ${parsed.error.message}` };
    }
    const { paths, pattern, contentPattern, maxDepth, includeContent, maxFiles } = parsed.data;
    const cwd = getProjectRoot();
    // Normalize paths to array
    let inputPaths;
    if (Array.isArray(paths)) {
        inputPaths = paths;
    }
    else if (typeof paths === 'string') {
        const trimmed = paths.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    inputPaths = parsed;
                }
                else {
                    inputPaths = [paths];
                }
            }
            catch {
                inputPaths = [paths];
            }
        }
        else {
            inputPaths = [paths];
        }
    }
    else {
        inputPaths = [String(paths)];
    }
    const allFiles = [];
    for (const inputPath of inputPaths) {
        const resolvedPath = await validatePath(inputPath);
        if (!existsSync(resolvedPath)) {
            continue;
        }
        const stat = statSync(resolvedPath);
        if (stat.isDirectory()) {
            const dirFiles = collectFiles(resolvedPath, pattern, maxDepth);
            allFiles.push(...dirFiles);
        }
        else if (stat.isFile()) {
            if (!pattern || matchesPattern(relative(cwd, resolvedPath), pattern)) {
                allFiles.push(resolvedPath);
            }
        }
    }
    const limitedFiles = allFiles.slice(0, maxFiles);
    const totalFiles = allFiles.length;
    const files = [];
    let totalContent = 0;
    for (const filePath of limitedFiles) {
        if (totalContent >= MAX_TOTAL_CONTENT)
            break;
        const stat = statSync(filePath);
        const entry = {
            path: relative(cwd, filePath) || filePath,
            size: stat.size,
        };
        if (includeContent) {
            const remainingSpace = MAX_TOTAL_CONTENT - totalContent;
            const maxLen = Math.min(MAX_CONTENT_LENGTH, remainingSpace);
            const { content, truncated, totalLines, lineRange } = readFileContent(filePath, { maxLength: maxLen });
            if (contentPattern) {
                const matches = findMatches(content, contentPattern);
                if (matches === null) {
                    entry.content = content;
                    entry.truncated = truncated;
                    entry.totalLines = totalLines;
                    entry.lineRange = lineRange;
                    totalContent += content.length;
                }
                else if (matches.length > 0) {
                    entry.matches = matches;
                    entry.content = content;
                    entry.truncated = truncated;
                    entry.totalLines = totalLines;
                    entry.lineRange = lineRange;
                    totalContent += content.length;
                }
                else {
                    continue;
                }
            }
            else {
                entry.content = content;
                entry.truncated = truncated;
                entry.totalLines = totalLines;
                entry.lineRange = lineRange;
                totalContent += content.length;
            }
        }
        files.push(entry);
    }
    let message = `Read ${files.length} file(s)`;
    if (totalFiles > maxFiles) {
        message += ` (showing ${maxFiles} of ${totalFiles})`;
    }
    if (contentPattern) {
        message += ` matching "${contentPattern}"`;
    }
    return {
        success: true,
        result: {
            files,
            totalFiles,
            message,
        },
    };
}
//# sourceMappingURL=read-many-files.js.map