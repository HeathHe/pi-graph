/**
 * Spec Keyword Bridge — Session-based dedup for keyword-triggered spec injection.
 *
 * Tracks which keywords and entries have already been injected in the current session
 * to prevent duplicate injection when the same keyword appears in multiple prompts.
 *
 * Bridge file: {tmpdir}/spec-kw-{sessionId}.json
 */
export interface SpecKeywordBridge {
    session_id: string;
    injected_keywords: string[];
    injected_entries: string[];
    updated_at: number;
}
/**
 * Read the spec keyword bridge file for a session.
 * Returns null if the file does not exist or is unreadable.
 */
export declare function readSpecBridge(sessionId: string): SpecKeywordBridge | null;
/**
 * Mark keywords and entry IDs as injected for this session.
 * Merges with existing bridge data (additive, never removes).
 */
export declare function markInjected(sessionId: string, keywords: string[], entryIds: string[]): void;
/**
 * Check if a keyword has already been injected this session.
 */
export declare function isKeywordInjected(sessionId: string, keyword: string): boolean;
/**
 * Check if an entry has already been injected this session.
 */
export declare function isEntryInjected(sessionId: string, entryId: string): boolean;
/**
 * Filter entries to only those not yet injected in this session.
 * An entry is considered "already injected" if its ID is in the bridge.
 */
export declare function filterUnjected<T extends {
    id: string;
}>(sessionId: string, entries: T[]): T[];
//# sourceMappingURL=spec-bridge.d.ts.map