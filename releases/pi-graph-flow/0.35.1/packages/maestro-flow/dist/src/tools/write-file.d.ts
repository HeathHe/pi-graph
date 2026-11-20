/**
 * Write File Tool - Create or overwrite files
 *
 * Features:
 * - Create new files or overwrite existing
 * - Auto-create parent directories
 * - Support for text content with proper encoding
 * - Optional backup before overwrite
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
interface WriteResult {
    path: string;
    bytes: number;
    message: string;
}
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult<WriteResult>>;
export {};
//# sourceMappingURL=write-file.d.ts.map