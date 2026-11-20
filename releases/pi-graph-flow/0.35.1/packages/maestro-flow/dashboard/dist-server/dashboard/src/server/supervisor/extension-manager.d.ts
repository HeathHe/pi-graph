import type { DashboardEventBus } from '../state/event-bus.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { PromptRegistry } from '../prompt/prompt-registry.js';
import type { ExtensionInfo } from '../../shared/extension-types.js';
export declare class ExtensionManager {
    private readonly eventBus;
    private readonly agentManager;
    private readonly promptRegistry?;
    private readonly extensions;
    constructor(eventBus: DashboardEventBus, agentManager: AgentManager, promptRegistry?: PromptRegistry | undefined);
    /** Scan registries and emit extension_loaded event */
    init(): void;
    /** Return all discovered extensions */
    listExtensions(): ExtensionInfo[];
    /** Find a single extension by name */
    getExtension(name: string): ExtensionInfo | undefined;
    private toInfo;
}
