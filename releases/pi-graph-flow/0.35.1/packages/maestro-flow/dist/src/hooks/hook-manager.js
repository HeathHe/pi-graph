import { WorkflowHookRegistry } from './workflow-hooks.js';
import { loadHooksConfig } from '../config/index.js';
export class HookManager {
    config;
    registry;
    constructor(config) {
        this.config = config ?? loadHooksConfig();
        this.registry = new WorkflowHookRegistry();
    }
    applyPlugin(plugin) {
        if (this.config.toggles[plugin.name] === false)
            return;
        this.registry.apply(plugin);
    }
    isEnabled(hookName) {
        return this.config.toggles[hookName] !== false;
    }
    getRegistry() {
        return this.registry;
    }
    getConfig() {
        return this.config;
    }
}
//# sourceMappingURL=hook-manager.js.map