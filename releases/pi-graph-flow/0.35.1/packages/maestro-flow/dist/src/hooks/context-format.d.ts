/**
 * Context Format — unified <maestro-context> container
 *
 * Single source of truth for the shape of injected context across all hook
 * injectors (spec-injector and the composed keyword/spec/wiki/KG prompt hook).
 *
 * Before this module each injector emitted its own wrapper tag
 * (<spec-keyword-match>, <kg-symbol-context>, <kg-context>, or none).
 * Now every injector builds `ContextSection[]` and calls `wrapMaestroContext`
 * to produce one consistent, compact block:
 *
 *   <maestro-context budget="used/max">
 *   ## label1
 *   - line
 *   - line
 *   ## label2
 *   - line
 *   </maestro-context>
 *
 * FUTURE WORK: budget coordination is still per-injector — each injector calls
 * evaluateContextBudget independently and reports its own used/max here. A
 * cross-injector budget pool (shared token accounting across all hooks in one
 * turn) is intentionally NOT implemented yet to avoid behavioral risk; this
 * change unifies the FORMAT only.
 */
export interface ContextSection {
    /** Section heading shown after `## ` (e.g. 'specs', 'kg-symbols'). */
    label: string;
    /** Content lines; each rendered as a `- ` bullet. Empty lines are dropped. */
    lines: string[];
}
export interface ContextBudgetInfo {
    used: number;
    max: number;
}
/**
 * Wrap context sections in a single compact <maestro-context> block.
 *
 * - Skips sections that have no non-empty lines.
 * - Renders each line as a `- ` bullet, no blank lines between items.
 * - Emits a `budget="used/max"` attribute on the opening tag.
 *
 * Returns an empty string when there is nothing to inject.
 */
export declare function wrapMaestroContext(sections: ContextSection[], budget: ContextBudgetInfo): string;
/** Truncate a wrapped context without exceeding maxChars or losing its close tag. */
export declare function truncateMaestroContext(content: string, maxChars: number): string;
//# sourceMappingURL=context-format.d.ts.map