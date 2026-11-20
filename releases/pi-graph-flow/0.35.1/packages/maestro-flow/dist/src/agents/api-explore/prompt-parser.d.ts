/**
 * Structured prompt format for maestro explore:
 *
 *   FIND: <what to search for — the core query>
 *   SCOPE: <file patterns, directories, or modules>
 *   EXCLUDE: <what to skip — files, patterns, false positives>
 *   ATTENTION: <caveats, edge cases, things to watch for>
 *   EXPECTED: <output format — evidence list, summary, JSON>
 *
 * Also accepts plain text (passed through unchanged).
 * Legacy fields PURPOSE/FOCUS/CONSTRAINTS map to FIND/ATTENTION/EXCLUDE.
 */
export interface StructuredPrompt {
    find: string;
    scope?: string;
    exclude?: string;
    attention?: string;
    expected?: string;
}
export declare function isStructuredPrompt(text: string): boolean;
export declare function parseStructuredPrompt(text: string): StructuredPrompt;
export declare function buildExplorePrompt(input: string | StructuredPrompt): string;
//# sourceMappingURL=prompt-parser.d.ts.map