/**
 * Edit File Tool - AI-focused file editing
 * Two complementary modes:
 * - update: Content-driven text replacement (AI primary use)
 * - line: Position-driven line operations (precise control)
 *
 * Features:
 * - dryRun mode for previewing changes
 * - Git-style diff output
 * - Multi-edit support in update mode
 * - Auto line-ending adaptation (CRLF/LF)
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
export declare const schema: ToolSchema;
interface CompactEditResult {
    path: string;
    modified: boolean;
    message: string;
    replacements?: number;
    diff?: string;
    dryRun?: boolean;
}
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult<CompactEditResult>>;
export {};
//# sourceMappingURL=edit-file.d.ts.map