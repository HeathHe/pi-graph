export type ExtensionType = 'strategy' | 'builder' | 'adapter' | 'task' | 'tool';
export interface ExtensionContext {
    eventBus: unknown;
    strategyRegistry: unknown;
    promptRegistry: unknown;
    agentManager: unknown;
    journal: unknown;
}
export interface ExtensionManifest {
    name: string;
    version: string;
    type: ExtensionType;
    entryPoint: string;
    config?: Record<string, unknown>;
}
export interface SupervisorExtension {
    name: string;
    version: string;
    type: ExtensionType;
    description: string;
    init(ctx: ExtensionContext): Promise<void> | void;
    destroy(): Promise<void> | void;
}
export interface ExtensionInfo {
    name: string;
    version: string;
    type: ExtensionType;
    description: string;
    status: 'enabled' | 'disabled';
}
