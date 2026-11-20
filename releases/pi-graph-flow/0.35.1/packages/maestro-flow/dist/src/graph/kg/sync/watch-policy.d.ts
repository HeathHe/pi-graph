/**
 * 检测是否在 WSL2 环境中运行
 * /mnt/* 路径 → drvfs 文件系统, recursive watch 性能极差
 */
export declare function isWSL2(): boolean;
/**
 * 检测当前工作目录是否在 drvfs 挂载点上
 * /mnt/c, /mnt/d 等路径应禁用 recursive watch
 */
export declare function isOnDrvFs(projectPath: string): boolean;
export interface WatchStrategy {
    /** 是否可以使用 recursive watch */
    canUseRecursiveWatch: boolean;
    /** 是否应使用 git hooks 作为替代 */
    useGitHooks: boolean;
    /** 原因说明 */
    reason: string;
}
/**
 * 决定文件监听策略
 *
 * 策略优先级:
 * 1. 正常文件系统 → recursive watch
 * 2. WSL2 drvfs → git hooks 替代
 * 3. 不支持 → 手动同步
 */
export declare function decideWatchStrategy(projectPath: string): WatchStrategy;
export declare const GIT_HOOK_SCRIPT = "#!/bin/sh\n# MaestroGraph incremental sync \u2014 triggered by git hooks\n# Install: ln -sf ../../.workflow/kg/hooks/post-commit .git/hooks/post-commit\n\nMAESTRO_ROOT=\"$(git rev-parse --show-toplevel)\"\nif [ -f \"$MAESTRO_ROOT/.workflow/kg/maestro.db\" ]; then\n  cd \"$MAESTRO_ROOT\" && npx maestro kg sync --incremental >>\"$MAESTRO_ROOT/.workflow/kg/sync-hook.log\" 2>&1 || true\nfi\n";
/**
 * 检查 git hooks 是否已安装
 */
export declare function areGitHooksInstalled(projectPath: string): boolean;
//# sourceMappingURL=watch-policy.d.ts.map