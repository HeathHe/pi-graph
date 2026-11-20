import type { HookLevel } from '../commands/hooks.js';
import type { ExtraMcpTargetId } from '../commands/install-backend.js';
import { type Manifest } from './manifest.js';
export interface InstallProfile {
    $schema: string;
    name: string;
    createdAt: string;
    scope: 'global' | 'project';
    components: {
        enabled: boolean;
        selectedIds: string[];
        /** Component catalog visible when the profile was created. */
        knownIds?: string[];
    };
    claude: {
        hooks: {
            enabled: boolean;
            basePreset: HookLevel;
            selectedHooks: string[];
            isCustom: boolean;
        };
        mcp: {
            enabled: boolean;
            tools: string[];
            projectRoot: string;
        };
        statusline: {
            enabled: boolean;
            theme: string;
        };
    };
    codex: {
        hooks: {
            enabled: boolean;
            basePreset: HookLevel;
            selectedHooks: string[];
            isCustom: boolean;
        };
        mcp: {
            enabled: boolean;
            tools: string[];
            projectRoot: string;
        };
    };
    agy: {
        hooks: {
            enabled: boolean;
            basePreset: HookLevel;
            selectedHooks: string[];
            isCustom: boolean;
        };
    };
    genericHooks?: Record<string, HookLevel>;
    extraMcp: {
        enabled: boolean;
        targetIds: ExtraMcpTargetId[];
    };
    backup: {
        claudeMd: boolean;
        all: boolean;
    };
    plugin?: {
        enabled: boolean;
        claude: boolean;
        codex: boolean;
    };
}
export declare function getProfileDir(): string;
export declare function exportProfile(profile: InstallProfile, filePath?: string): string;
export declare function importProfile(filePath: string): InstallProfile;
export interface ProfileSummary {
    name: string;
    filePath: string;
    scope: string;
    createdAt: string;
}
/**
 * Build an InstallProfile directly from a Manifest object.
 * Used by `maestro update` reinstall — avoids the findManifest() lookup
 * since the caller already has the manifest in hand.
 */
export declare function manifestToProfile(manifest: Manifest): InstallProfile;
export declare function exportProfileFromManifest(scope: 'global' | 'project', filePath?: string): string;
export declare function configToProfile(config: import('../tui/install-ui/types.js').InstallFlowConfig, name?: string): InstallProfile;
export interface ProfileApplyResult {
    mode: 'global' | 'project';
    enabledSteps: Record<string, boolean>;
    selectedComponentIds: string[];
    claudeHooks: {
        basePreset: HookLevel;
        selectedHooks: string[];
        isCustom: boolean;
    };
    mcpEnabled: boolean;
    mcpTools: string[];
    mcpProjectRoot: string;
    codexHooks: {
        basePreset: HookLevel;
        selectedHooks: string[];
        isCustom: boolean;
    };
    codexMcpEnabled: boolean;
    codexMcpTools: string[];
    codexMcpProjectRoot: string;
    agyHooks: {
        basePreset: HookLevel;
        selectedHooks: string[];
        isCustom: boolean;
    };
    genericHookLevels: Record<string, HookLevel>;
    extraMcpTargetIds: ExtraMcpTargetId[];
    installStatusline: boolean;
    statuslineTheme: string;
    backupClaudeMd: boolean;
    backupAll: boolean;
}
export declare function profileToStateValues(profile: InstallProfile): ProfileApplyResult;
export declare function listProfiles(): ProfileSummary[];
//# sourceMappingURL=install-profile.d.ts.map