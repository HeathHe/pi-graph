import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
/**
 * In-process plugin for `maestro coordinate` — injects relevant specs
 * into the prompt via the `transformPrompt` waterfall hook.
 *
 * This is the coordinator counterpart to the Claude Code `spec-injector`
 * subprocess hook. Both reuse the same spec-loader infrastructure.
 */
export declare class SpecInjectionPlugin implements MaestroPlugin {
    private readonly projectPath;
    private readonly sessionId;
    readonly name = "specInjection";
    constructor(projectPath?: string, sessionId?: string);
    apply(registry: WorkflowHookRegistry): void;
}
//# sourceMappingURL=spec-injection-plugin.d.ts.map