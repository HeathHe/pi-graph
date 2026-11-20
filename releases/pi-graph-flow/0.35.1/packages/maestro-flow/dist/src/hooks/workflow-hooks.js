// ---------------------------------------------------------------------------
// WorkflowHookRegistry — Central registry of 9 workflow hooks
// ---------------------------------------------------------------------------
import { SyncHook, AsyncSeriesHook, AsyncSeriesBailHook, AsyncSeriesWaterfallHook, } from './hook-engine.js';
// ---------------------------------------------------------------------------
// WorkflowHookRegistry
// ---------------------------------------------------------------------------
export class WorkflowHookRegistry {
    /** Fires before a workflow run starts. Bail to cancel. */
    beforeRun = new AsyncSeriesBailHook();
    /** Fires after a workflow run completes. */
    afterRun = new AsyncSeriesHook();
    /** Fires before entering a node. Bail to skip. */
    beforeNode = new AsyncSeriesBailHook();
    /** Fires after exiting a node. */
    afterNode = new AsyncSeriesHook();
    /** Fires before executing a command. Bail to skip execution. */
    beforeCommand = new AsyncSeriesBailHook();
    /** Fires after a command completes. */
    afterCommand = new AsyncSeriesHook();
    /** Fires when an error occurs during execution. */
    onError = new AsyncSeriesHook();
    /** Transforms the assembled prompt before sending to agent. */
    transformPrompt = new AsyncSeriesWaterfallHook();
    /** Fires synchronously when a decision node resolves. */
    onDecision = new SyncHook();
    /** Apply a plugin — plugin taps into hooks via the registry. */
    apply(plugin) {
        plugin.apply(this);
    }
    /** Get a hook by name (for dynamic access). */
    getHook(name) {
        const hooks = {
            beforeRun: this.beforeRun,
            afterRun: this.afterRun,
            beforeNode: this.beforeNode,
            afterNode: this.afterNode,
            beforeCommand: this.beforeCommand,
            afterCommand: this.afterCommand,
            onError: this.onError,
            transformPrompt: this.transformPrompt,
            onDecision: this.onDecision,
        };
        return hooks[name];
    }
}
//# sourceMappingURL=workflow-hooks.js.map