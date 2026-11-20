import type { ComponentType } from 'react';
export interface RenderTuiOptions {
    exitOnCtrlC?: boolean;
}
/**
 * Render an ink React component as a full-screen TUI.
 *
 * - Dynamically imports ink + React (preserves tree-shaking / lazy loading).
 * - Registers SIGINT / SIGTERM handlers and cleans them up on exit.
 * - Resolves when the ink app unmounts.
 */
export declare function renderTui<P extends object>(component: ComponentType<P>, props: P, options?: RenderTuiOptions): Promise<void>;
//# sourceMappingURL=render.d.ts.map