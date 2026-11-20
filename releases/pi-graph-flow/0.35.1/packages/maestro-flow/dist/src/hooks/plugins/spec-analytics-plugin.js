// ---------------------------------------------------------------------------
// SpecAnalyticsPlugin — Tracks all workflow hook invocations
// ---------------------------------------------------------------------------
import { logHookInvocation } from '../spec-analytics.js';
/**
 * Plugin that taps into all 9 workflow hooks to record invocations.
 * Captures hook name, node context, timing, and outcome.
 */
export class SpecAnalyticsPlugin {
    projectPath;
    name = 'specAnalytics';
    constructor(projectPath = process.cwd()) {
        this.projectPath = projectPath;
    }
    apply(registry) {
        const pp = this.projectPath;
        registry.beforeRun.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'beforeRun',
                pluginName: this.name,
                data: { sessionId: ctx.sessionId, graphId: ctx.graphId, intent: ctx.intent },
            });
            return undefined; // Don't bail
        });
        registry.afterRun.tap(this.name, (ctx, state) => {
            logHookInvocation(pp, {
                hookName: 'afterRun',
                pluginName: this.name,
                data: { sessionId: ctx.sessionId, status: state.status },
            });
        });
        registry.beforeNode.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'beforeNode',
                pluginName: this.name,
                nodeId: ctx.nodeId,
                data: { nodeType: ctx.node.type },
            });
            return undefined; // Don't bail
        });
        registry.afterNode.tap(this.name, (ctx, outcome) => {
            logHookInvocation(pp, {
                hookName: 'afterNode',
                pluginName: this.name,
                nodeId: ctx.nodeId,
                outcome,
            });
        });
        registry.beforeCommand.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'beforeCommand',
                pluginName: this.name,
                nodeId: ctx.nodeId,
                data: { cmd: ctx.cmd },
            });
            return undefined; // Don't bail
        });
        registry.afterCommand.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'afterCommand',
                pluginName: this.name,
                nodeId: ctx.nodeId,
                data: { cmd: ctx.cmd, success: ctx.result.success },
            });
        });
        registry.onError.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'onError',
                pluginName: this.name,
                nodeId: ctx.nodeId ?? undefined,
                data: { message: ctx.error.message },
            });
        });
        registry.transformPrompt.tap(this.name, (prompt) => {
            logHookInvocation(pp, {
                hookName: 'transformPrompt',
                pluginName: this.name,
                data: { promptLength: prompt.length },
            });
            return prompt; // Pass-through, observation only
        });
        registry.onDecision.tap(this.name, (ctx) => {
            logHookInvocation(pp, {
                hookName: 'onDecision',
                pluginName: this.name,
                nodeId: ctx.nodeId,
                data: { target: ctx.target },
            });
        });
    }
}
//# sourceMappingURL=spec-analytics-plugin.js.map