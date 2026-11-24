import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBrowserTool } from "./browser-tool.ts";
import { createComputerUseTool } from "./computer-use-tool.ts";
import type { BrowserManagerLike } from "./browser/manager.ts";
import type { browserBridge } from "./browser/bridge-server.ts";
import { browserSessionScopes } from "./browser/session-scope.ts";
import { computerUseManager, type ComputerUseManagerLike } from "./computer-use/manager.ts";
import { createLspTool } from "./lsp-tool.ts";
import { registerLspAutoDiagnostics } from "./lsp/auto-diagnostics.ts";
import { lspManager } from "./lsp/manager.ts";
import type { LspManagerLike } from "./lsp/types.ts";
import { registerSearchToolBm25 } from "./search-tool-bm25.ts";
import { registerSmartSearch } from "./smart-search.ts";
import { createSourceCheckTool } from "./web-access/source-check-tool.ts";
import { registerCuratorCommands } from "./web-access/curator.ts";

export function registerIntelligenceTools(pi: ExtensionAPI): void {
  pi.registerTool(createLspTool());
  registerLspAutoDiagnostics(pi);
  pi.registerTool(createBrowserTool());
  pi.registerTool(createComputerUseTool());
  registerSearchToolBm25(pi);
  registerSmartSearch(pi);
  pi.registerTool(createSourceCheckTool() as never);
  registerCuratorCommands(pi);
}

export async function shutdownIntelligenceTools(
  dependencies: {
    lsp: Pick<LspManagerLike, "shutdown">;
    browser: Pick<BrowserManagerLike, "closeAll">;
    /** Supply only for an exclusively owned bridge, never the shared host bridge. */
    bridge?: Pick<typeof browserBridge, "shutdown">;
    computerUse?: Pick<ComputerUseManagerLike, "shutdown">;
  } | undefined = undefined,
  timeoutMs = 5_000,
  hostSessionId?: string,
): Promise<void> {
  dependencies ??= {
    lsp: lspManager,
    browser: { closeAll: () => browserSessionScopes.closeSession(hostSessionId) },
    computerUse: computerUseManager,
  };
  // Capture/fence the outgoing scope synchronously. The host bridge is shared
  // with other sessions, teammate actors and Gateway managers (not all tracked
  // here), so session shutdown cannot prove exclusive ownership and must leave
  // it running. Process teardown owns its final shutdown. Even an explicitly
  // owned bridge may stop only after successful resource cleanup, never finally.
  const { browser, bridge } = dependencies;
  const browserCleanup = (async () => {
    await browser.closeAll();
    await bridge?.shutdown();
  })();
  const cleanup = Promise.allSettled([
    dependencies.lsp.shutdown(),
    browserCleanup,
    ...(dependencies.computerUse ? [dependencies.computerUse.shutdown()] : []),
  ]).then(() => undefined);
  let timer: NodeJS.Timeout;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
