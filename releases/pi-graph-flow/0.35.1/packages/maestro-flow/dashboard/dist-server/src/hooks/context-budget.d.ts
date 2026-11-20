/**
 * Context Budget Manager
 *
 * Determines how much spec content to inject based on remaining context %.
 * Reads bridge metrics written by the statusline hook.
 *
 * Budget tiers:
 *   > 50% remaining  → full    (inject all specs)
 *   35–50%           → reduced (markdown-aware truncation)
 *   25–35%           → minimal (headings only + learnings)
 *   < 25%            → skip    (context is critical)
 */
export type BudgetAction = 'full' | 'reduced' | 'minimal' | 'skip';
export interface BudgetResult {
    action: BudgetAction;
    content?: string;
    reason?: string;
}
/**
 * Decide how much spec content to inject given current context budget.
 * If no bridge metrics are available, defaults to 'full' (be generous).
 */
export declare function evaluateContextBudget(specContent: string, sessionId?: string): BudgetResult;
/**
 * Markdown-aware truncation: preserve headings + first paragraph per section.
 * Inserts "[... N lines omitted]" for collapsed sections.
 */
export declare function truncateMarkdown(content: string, maxChars: number): string;
