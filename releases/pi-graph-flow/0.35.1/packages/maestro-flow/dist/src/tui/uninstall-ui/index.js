import { renderTui } from '../render.js';
export async function runUninstallFlow(manifests) {
    const { UninstallFlow } = await import('./UninstallFlow.js');
    await renderTui(UninstallFlow, { manifests });
}
//# sourceMappingURL=index.js.map