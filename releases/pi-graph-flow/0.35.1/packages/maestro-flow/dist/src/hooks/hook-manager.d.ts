import type { HooksConfig, MaestroPlugin } from '../types/index.js';
import { WorkflowHookRegistry } from './workflow-hooks.js';
export declare class HookManager {
    private config;
    private registry;
    constructor(config?: HooksConfig);
    applyPlugin(plugin: MaestroPlugin): void;
    isEnabled(hookName: string): boolean;
    getRegistry(): WorkflowHookRegistry;
    getConfig(): HooksConfig;
}
//# sourceMappingURL=hook-manager.d.ts.map