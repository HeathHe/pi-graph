/** Minimal entry shape — mirrors NormalizedEntry without importing it. */
export interface EntryLike {
    type: string;
    [key: string]: unknown;
}
export interface ExecutionMeta {
    execId: string;
    tool: string;
    model?: string;
    mode: string;
    prompt: string;
    workDir: string;
    startedAt: string;
    completedAt?: string;
    cancelledAt?: string;
    exitCode?: number;
}
export interface ExecutionSnapshot {
    execId: string;
    tool: string;
    mode: string;
    workDir: string;
    prompt: string;
    startedAt: string;
    completedAt: string | null;
    exitCode: number | null;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    outputPreview: string;
    outputChars: number;
}
export declare const CLI_EXEC_ID_RE: RegExp;
export declare function isValidCliExecId(execId: string): boolean;
export declare function assertValidCliExecId(execId: string): void;
export declare class CliHistoryStore {
    private get dir();
    private jsonlPath;
    private metaPath;
    /** Expose JSONL file path for a given execution (used by watch). */
    jsonlPathFor(execId: string): string;
    /** Append a single entry as one JSONL line. */
    appendEntry(execId: string, entry: EntryLike): void;
    /** Save (or overwrite) execution metadata. */
    saveMeta(execId: string, meta: ExecutionMeta): void;
    /** Load execution metadata, or null if not found. */
    loadMeta(execId: string): ExecutionMeta | null;
    /**
     * Load JSONL entries filtered for resume context.
     * Excludes status_change, token_usage, thinking, approval_*, user_message,
     * and partial assistant_message entries.
     */
    loadForResume(execId: string): EntryLike[];
    /**
     * Build a resume prompt by loading previous session context and wrapping
     * it with the new prompt.
     *
     * Supports single or comma-separated execIds for merge scenarios.
     */
    buildResumePrompt(execIds: string | string[], newPrompt: string): string;
    /** List recent execution metadata, sorted by modification time descending. */
    listRecent(limit?: number): ExecutionMeta[];
    /** Get final output text from an execution's JSONL. */
    /**
     * Extract output text from persisted JSONL history.
     *
     * By default returns only final assistant output (excludes thinking/reasoning).
     * Use `includeAll` to include thinking entries as well.
     * Use `offset`/`limit` for pagination (character-based).
     */
    getOutput(execId: string, options?: {
        includeAll?: boolean;
        lastReply?: boolean;
        offset?: number;
        limit?: number;
    }): string;
    /** Extract only the last segment of assistant messages after the last tool/command boundary. */
    private extractLastReply;
    /** Extract all assistant output, preferring non-partial messages with partial fallback. */
    private extractFullOutput;
    /** Return total character count of assistant output (for pagination metadata). */
    getOutputLength(execId: string): number;
    /** Build a compact snapshot for async broker updates from persisted history. */
    buildSnapshot(execId: string): ExecutionSnapshot | null;
}
//# sourceMappingURL=cli-history-store.d.ts.map