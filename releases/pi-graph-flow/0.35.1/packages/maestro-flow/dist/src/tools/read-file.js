/**
 * Read File Tool - Single file precise reading with optional line pagination
 *
 * Features:
 * - Read a single file with full content
 * - Line-based pagination with offset/limit
 * - Binary file detection
 */
import { z } from 'zod';
import { existsSync, statSync } from 'fs';
import { relative } from 'path';
import { validatePath, getProjectRoot } from '../utils/path-validator.js';
import { MAX_CONTENT_LENGTH, readFileContent, } from '../utils/file-reader.js';
const ParamsSchema = z.object({
    path: z.string().describe('Single file path to read'),
    offset: z.number().min(0).optional().describe('Line offset to start reading from (0-based)'),
    limit: z.number().min(1).optional().describe('Number of lines to read'),
});
export const schema = {
    name: 'read_file',
    description: `Read a single file with optional line-based pagination.

Usage:
  read_file(path="file.ts")                        # Full content
  read_file(path="file.ts", offset=100, limit=50)  # Lines 100-149 (0-based)

Supports both absolute and relative paths. Relative paths are resolved from project root.
Use offset/limit for large file pagination.`,
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Single file path to read',
            },
            offset: {
                type: 'number',
                description: 'Line offset to start reading from (0-based)',
                minimum: 0,
            },
            limit: {
                type: 'number',
                description: 'Number of lines to read',
                minimum: 1,
            },
        },
        required: ['path'],
    },
};
export async function handler(params) {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
        return { success: false, error: `Invalid params: ${parsed.error.message}` };
    }
    const { path: filePath, offset, limit } = parsed.data;
    const cwd = getProjectRoot();
    const resolvedPath = await validatePath(filePath);
    if (!existsSync(resolvedPath)) {
        return { success: false, error: `File not found: ${filePath}` };
    }
    const stat = statSync(resolvedPath);
    if (!stat.isFile()) {
        return { success: false, error: `Not a file: ${filePath}. Use read_many_files for directories.` };
    }
    const { content, truncated, totalLines, lineRange } = readFileContent(resolvedPath, {
        maxLength: MAX_CONTENT_LENGTH,
        offset,
        limit,
    });
    const entry = {
        path: relative(cwd, resolvedPath) || filePath,
        size: stat.size,
        content,
        truncated,
        totalLines,
        lineRange,
    };
    let message = `Read 1 file`;
    if (lineRange) {
        message += ` [lines ${lineRange.start}-${lineRange.end} of ${totalLines}]`;
    }
    return {
        success: true,
        result: {
            files: [entry],
            totalFiles: 1,
            message,
        },
    };
}
//# sourceMappingURL=read-file.js.map