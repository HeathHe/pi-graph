export type { InstallFlowConfig } from './types.js';
export type { HooksSelection } from './HooksConfig.js';
/**
 * @deprecated 新调用方请使用 {@link runInstallFlow}。保留原因：仍支撑遗留的
 * `install wizard` CLI 子命令（CyberdeckBlueprint TUI），且是公开 tui API 的
 * 一部分（经 src/tui/index.ts 再导出）。迁移该命令前不要移除。
 */
export declare function runInstallWizard(pkgRoot: string, version: string): Promise<void>;
export interface InstallFlowOptions {
    /** 'mode' is accepted for backward compat but maps to 'hub' internally */
    initialStep?: 'mode' | 'hub' | 'components_config' | 'hooks_config' | 'mcp_config' | 'codex_hooks_config' | 'codex_mcp_config' | 'agy_hooks_config' | 'extra_mcp_config' | 'statusline_config' | 'backup_config' | 'confirm';
    initialMode?: 'global' | 'project';
    initialStepIds?: string[];
    initialProjectPath?: string;
}
export declare function runInstallFlow(pkgRoot: string, version: string, options?: InstallFlowOptions): Promise<void>;
//# sourceMappingURL=index.d.ts.map