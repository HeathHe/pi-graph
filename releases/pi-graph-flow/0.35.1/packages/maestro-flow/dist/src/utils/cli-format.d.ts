import type { EntryLike, ExecutionMeta } from '../agents/cli-history-store.js';
export declare function deriveExecutionStatus(meta: ExecutionMeta | null): string;
export type DelegateJobLike = {
    status: string;
    metadata?: Record<string, unknown> | null;
} | null;
export declare function deriveDelegateStatus(meta: ExecutionMeta | null, job: DelegateJobLike): string;
export declare function padRight(str: string, len: number): string;
/**
 * Collapse newlines to spaces, trim, then truncate with "...".
 * Used by CLI table output (cli show, delegate show).
 */
export declare function truncate(text: string, max: number): string;
/**
 * Truncate without newline collapsing — just cutoff with "...".
 * Used by channel relay notifications.
 */
export declare function truncateRaw(value: string, max: number): string;
/**
 * Truncate with ellipsis indicator for history/resume context.
 * Uses different suffix from other truncate variants.
 */
export declare function truncateForHistory(s: string, max: number): string;
/**
 * Extract the best-matching body line for a query, prefixed with its line
 * number (e.g. "L12: matched context..."). Scores lines by query-term
 * coverage so multi-term queries surface the most informative line.
 */
export declare function extractSnippet(body: string, query: string, maxLen?: number, highlight?: boolean): string | null;
export declare function highlightTerms(text: string, terms: string[]): string;
export declare function readExecutionEntries(store: {
    jsonlPathFor(execId: string): string;
}, execId: string): EntryLike[];
/**
 * CLI-friendly single-line summary of a broker event.
 * Used by `delegate status` and `delegate tail` commands.
 */
export declare function summarizeBrokerEventCli(event: {
    eventId: number;
    type: string;
    status?: string;
    payload: Record<string, unknown>;
    snapshot?: unknown;
}): string;
/**
 * Structured summary of a broker event (object return).
 * Used by MCP tools (delegate_status, delegate_tail).
 */
export declare function summarizeBrokerEventStructured(event: {
    eventId: number;
    sequence: number;
    type: string;
    createdAt: string;
    status?: string;
    snapshot?: unknown;
    payload: Record<string, unknown>;
}): Record<string, unknown>;
//# sourceMappingURL=cli-format.d.ts.map