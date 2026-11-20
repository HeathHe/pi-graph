import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
/**
 * Plugin that taps into all 9 workflow hooks to record invocations.
 * Captures hook name, node context, timing, and outcome.
 */
export declare class SpecAnalyticsPlugin implements MaestroPlugin {
    private readonly projectPath;
    readonly name = "specAnalytics";
    constructor(projectPath?: string);
    apply(registry: WorkflowHookRegistry): void;
}
//# sourceMappingURL=spec-analytics-plugin.d.ts.map