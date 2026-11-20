import { renderTui } from '../render.js';
/** Unified config hub — tab-based switcher between all config panels. */
export async function runConfigHub(options) {
    const { ConfigHub } = await import('./ConfigHub.js');
    await renderTui(ConfigHub, {
        workDir: process.cwd(),
        ...options,
    });
}
/** Skills config TUI — direct entry. */
export async function runConfigTui(initialView = 'dashboard', editSkill) {
    return runConfigHub({ initialTab: 'Skills', skillsInitialView: initialView, editSkill });
}
/** Delegate config TUI — direct entry. */
export async function runDelegateConfigTui(initialView = 'dashboard') {
    return runConfigHub({ initialTab: 'Delegate', delegateInitialView: initialView });
}
/** Hooks panel — direct entry. */
export async function runHooksTui() {
    return runConfigHub({ initialTab: 'Hooks' });
}
/** Overlay panel — direct entry. */
export async function runOverlayTui() {
    return runConfigHub({ initialTab: 'Overlay' });
}
/** Specs panel — direct entry. */
export async function runSpecsTui() {
    return runConfigHub({ initialTab: 'Specs' });
}
/** Analytics panel — direct entry. */
export async function runSpecAnalyticsTui() {
    return runConfigHub({ initialTab: 'Analytics' });
}
/** Install panel — direct entry. */
export async function runInstallTui() {
    return runConfigHub({ initialTab: 'Install' });
}
//# sourceMappingURL=index.js.map