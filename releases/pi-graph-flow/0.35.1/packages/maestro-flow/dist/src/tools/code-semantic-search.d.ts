/**
 * Code Semantic Search Tool — MCP tool exposing hybrid FTS5 + embedding vector search.
 *
 * Wraps MaestroGraph.searchHybrid() for code symbol search.
 * Returns simplified result shape: { id, name, kind, filePath, startLine, score, signature, definition }
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
//# sourceMappingURL=code-semantic-search.d.ts.map