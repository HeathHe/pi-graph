export interface PluginPlatformState {
    installed: boolean;
    version: string;
    installedAt: string;
    stagingDir: string;
}
export interface PluginState {
    claude?: PluginPlatformState;
    codex?: PluginPlatformState;
}
export interface BuildResult {
    skills: number;
    agents: number;
    commands: number;
}
export declare function loadState(): PluginState;
export declare function buildClaudeStaging(pkgRoot: string, version: string): BuildResult;
export declare function buildCodexStaging(pkgRoot: string, version: string): BuildResult;
interface ExecResult {
    success: boolean;
    output: string;
}
export declare function registerClaudePlugin(): ExecResult;
export declare function unregisterClaudePlugin(): ExecResult;
export declare function registerCodexPlugin(): ExecResult;
export declare function unregisterCodexPlugin(): ExecResult;
export interface PlatformStatus {
    cliAvailable: boolean;
    marketplaceRegistered: boolean;
    pluginInstalled: boolean;
    detail: string;
}
export declare function getClaudeStatus(): PlatformStatus;
export declare function getCodexStatus(): PlatformStatus;
export interface PluginInstallResult {
    claude: {
        success: boolean;
        detail: string;
        stats: BuildResult;
    };
    codex: {
        success: boolean;
        detail: string;
        stats: BuildResult;
    };
}
export declare function installPlugin(pkgRoot: string, version: string, opts?: {
    claude?: boolean;
    codex?: boolean;
}): PluginInstallResult;
export declare function uninstallPlugin(opts?: {
    claude?: boolean;
    codex?: boolean;
    cleanStaging?: boolean;
}): {
    claude: string;
    codex: string;
};
export {};
//# sourceMappingURL=plugin-bridge.d.ts.map