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
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import { type ReadResult } from '../utils/file-reader.js';
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult<ReadResult>>;
//# sourceMappingURL=read-many-files.d.ts.map