import type { MaestroConfig, HooksConfig, SpecInjectionConfig, SpecAnalyticsConfig, WorkspaceConfig, WorkspaceLink } from '../types/index.js';
export declare function loadConfig(): MaestroConfig;
export declare function saveConfig(config: MaestroConfig): void;
export declare function loadSpecInjectionConfig(projectPath: string): SpecInjectionConfig;
export declare function saveSpecInjectionConfig(projectPath: string, config: SpecInjectionConfig): void;
export declare function loadAnalyticsConfig(projectPath: string): SpecAnalyticsConfig;
export declare function saveAnalyticsConfig(projectPath: string, config: SpecAnalyticsConfig): void;
export interface ResolvedWorkspaceLink extends WorkspaceLink {
    resolvedPath: string;
    workflowRoot: string;
    valid: boolean;
    identityPersisted: boolean;
    repoId: string | null;
    repoName: string;
    error?: string;
}
export declare function loadWorkspaceConfig(projectPath: string): WorkspaceConfig;
export declare function saveWorkspaceConfig(projectPath: string, config: WorkspaceConfig): void;
export declare function resolveWorkspaceLinks(projectPath: string, config: WorkspaceConfig): ResolvedWorkspaceLink[];
/** Convert user-facing hook names to the canonical config key used by runners. */
export declare function normalizeHookToggleKey(name: string): string;
/**
 * Normalize persisted aliases while giving an explicitly canonical key
 * precedence when both forms are present.
 */
export declare function normalizeHookToggles(toggles: Record<string, boolean> | undefined): Record<string, boolean>;
export declare function loadHooksConfig(): HooksConfig;
//# sourceMappingURL=index.d.ts.map