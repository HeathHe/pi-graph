/**
 * Keyword Spec Injector — UserPromptSubmit hook
 *
 * Scans user prompt for keywords, matches against <spec-entry> keyword attributes,
 * injects matching entries as additionalContext. Session dedup prevents re-injection.
 * Also injects domain term context (compact always + expanded on keyword match).
 */
export interface KeywordInjectionResult {
    inject: boolean;
    content?: string;
    matchedKeywords?: string[];
    matchedEntries?: number;
}
/**
 * Evaluate whether to inject keyword-matched spec entries for a user prompt.
 *
 * @param prompt      The user's prompt text
 * @param projectPath Working directory for spec file resolution
 * @param sessionId   Session ID for dedup bridge
 */
export declare function evaluateKeywordInjection(prompt: string, projectPath: string, sessionId: string): Promise<KeywordInjectionResult>;
/**
 * Resolve domain context for a spec-entry's domain="" attribute.
 * Returns a one-line definition or null if term not found.
 */
export declare function resolveDomainContext(domainId: string, projectPath: string): string | null;
//# sourceMappingURL=keyword-spec-injector.d.ts.map