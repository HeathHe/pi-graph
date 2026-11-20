/**
 * Read File Tool - Single file precise reading with optional line pagination
 *
 * Features:
 * - Read a single file with full content
 * - Line-based pagination with offset/limit
 * - Binary file detection
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import { type ReadResult } from '../utils/file-reader.js';
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult<ReadResult>>;
//# sourceMappingURL=read-file.d.ts.map