/**
 * Wiki Search Tool — MCP tool exposing low-latency BM25 with opt-in semantic reranking.
 *
 * Fast path: tries the search daemon first (no heavy imports).
 * Fallback: lazy-imports WikiIndexer for direct search.
 *
 * Result shape per entry:
 *   { id, title, type, scope, score, summary }
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
//# sourceMappingURL=wiki-search.d.ts.map