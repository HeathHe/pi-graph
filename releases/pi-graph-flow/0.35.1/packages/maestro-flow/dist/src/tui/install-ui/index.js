import { renderTui } from '../render.js';
/**
 * @deprecated 新调用方请使用 {@link runInstallFlow}。保留原因：仍支撑遗留的
 * `install wizard` CLI 子命令（CyberdeckBlueprint TUI），且是公开 tui API 的
 * 一部分（经 src/tui/index.ts 再导出）。迁移该命令前不要移除。
 */
export async function runInstallWizard(pkgRoot, version) {
    const { CyberdeckBlueprint } = await import('./CyberdeckBlueprint.js');
    await renderTui(CyberdeckBlueprint, { pkgRoot, version });
}
export async function runInstallFlow(pkgRoot, version, options) {
    const { InstallFlow } = await import('./InstallFlow.js');
    await renderTui(InstallFlow, { pkgRoot, version, ...options });
}
//# sourceMappingURL=index.js.map