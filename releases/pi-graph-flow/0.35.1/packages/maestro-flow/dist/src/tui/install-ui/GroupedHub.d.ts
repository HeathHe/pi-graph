import { type HookLevel } from '../../commands/hooks.js';
export interface HubItem {
    id: string;
    label: string;
    enabled: boolean;
    summary: string;
    /** Shown in right-side detail panel when focused */
    detail?: string;
    /** When true, shows a → arrow indicating Enter opens a config sub-step */
    hasConfig?: boolean;
}
export interface HubGroup {
    id: string;
    title: string;
    items: HubItem[];
}
interface GroupedHubProps {
    groups: HubGroup[];
    mode: 'global' | 'project';
    onModeChange: (mode: 'global' | 'project') => void;
    onToggle: (id: string) => void;
    onEnter: (id: string) => void;
    onInstall: () => void;
    onExport: () => void;
    onImport: () => void;
    onExit: () => void;
    /** Date string from last manifest, e.g. "2026-06-15" */
    lastInstallDate?: string | null;
}
export declare function GroupedHub({ groups, mode, onModeChange, onToggle, onEnter, onInstall, onExport, onImport, onExit, lastInstallDate, }: GroupedHubProps): import("react/jsx-runtime").JSX.Element;
export declare function buildGroupedHubItems(enabled: Record<string, boolean>, summaries: {
    componentCount: number;
    fileCount: number;
    hookLevel: HookLevel;
    hookSelectedCount?: number;
    hookTotalCount?: number;
    hookIsCustom?: boolean;
    mcpToolCount: number;
    mcpEnabled: boolean;
    codexHookLevel: HookLevel;
    codexMcpToolCount: number;
    codexMcpEnabled: boolean;
    codexHookSelectedCount?: number;
    codexHookTotalCount?: number;
    codexHookIsCustom?: boolean;
    agyHookLevel: HookLevel;
    agyHookSelectedCount?: number;
    agyHookTotalCount?: number;
    agyHookIsCustom?: boolean;
    extraMcpTargetCount: number;
    extraMcpTargetIds: string[];
    genericHookLevels: Record<string, HookLevel>;
    statuslineDetected: string | null;
    statuslineTheme?: string;
    backupClaudeMd: boolean;
    backupAll: boolean;
    selectedPlatforms: string[];
    selectedAddons: string[];
    chineseEnabled: boolean;
    addonDefs: Array<{
        id: string;
        label: string;
        description: string;
        platform: string;
    }>;
    embeddingMode?: 'local' | 'api';
    embeddingCached?: boolean;
    entryCommandSteps?: string[];
    entryCommandEligible?: number;
}): HubGroup[];
export {};
//# sourceMappingURL=GroupedHub.d.ts.map