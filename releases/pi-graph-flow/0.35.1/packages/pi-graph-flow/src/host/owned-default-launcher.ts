/** Owned entry composition. The original main remains the parser, mode and resource-policy owner.
 * Activation awaits the separately reviewed App preparation-failure policy; this module does not
 * alter the signed bridge or silently enable a new consent/security policy.
 */
import { main as hostedMain } from "m18:hosted-main";
import type { ExtensionAPI, MainOptions } from "@earendil-works/pi-coding-agent";
import type { RuntimeInput, RuntimeComposition, TrustedHostOptions } from "./host-types.js";
import { HostRoot } from "./main.js";
import { ConsentManager } from "../mcp/consent-manager.ts";
import { openUiSessionViewer } from "../mcp/ui-session-policy.ts";
import { openUrl } from "../mcp/utils.ts";
import { logger } from "../mcp/logger.ts";

/** One composition instance per original main invocation; one consent owner per actual runtime. */
export class OwnedDefaultHost implements TrustedHostOptions {
  #closed = false;
  #children = new Map<HostRoot, ConsentManager | undefined>();

  prepareRuntime(input: RuntimeInput): RuntimeComposition {
    if (this.#closed) throw new Error("Owned default host has closed");
    const slots = input.extensionFactories.filter(entry => typeof entry !== "function" && entry.builtin === true && entry.name === "mcp");
    if (slots.length > 1) throw new Error("Duplicate original builtin:mcp slots");
    // Absence is not permission to invent an MCP owner. Original loader still decides whether
    // a present builtin is enabled (--no-mcp/settings) and whether a FILE /mcp replaces it.
    if (slots.length === 0) {
      const host = new HostRoot();
      this.#children.set(host, undefined);
      return host.prepareRuntime(input);
    }
    const consentManager = new ConsentManager("once-per-server");
    const log = logger.child({ component: "NativeAppHost" });
    let api: ExtensionAPI | undefined;
    const host = new HostRoot({ nativeApp: {
      consentManager,
      // Omit mcp settings overrides: original createMcpExtension owns native config, OAuth,
      // auth storage, logging and requests; no legacy initializeMcp/manager is constructed.
      openUi: (url, context) => openUiSessionViewer(url, context, async target => {
        if (!context.current()) throw new Error("UI viewer is retired");
        const currentApi = api;
        if (!currentApi) throw new Error("Native MCP factory API is unavailable");
        await openUrl(currentApi, target, process.env.BROWSER);
        if (!context.current()) throw new Error("UI viewer is retired");
      }),
      audit: event => log.debug("Native App action", event),
      diagnostic: error => log.error("Native App operation failed", error instanceof Error ? error : undefined,
        { message: error instanceof Error ? error.message : String(error) }),
    } });
    this.#children.set(host, consentManager);
    try {
      const composition = host.prepareRuntime(input);
      const extensionFactories = composition.extensionFactories;
      if (!extensionFactories) throw new Error("Native MCP composition did not publish factories");
      const boundFactories = extensionFactories.map(entry => {
        if (typeof entry === "function" || entry.builtin !== true || entry.name !== "mcp") return entry;
        const originalFactory = entry.factory;
        return { ...entry, factory: (pi: ExtensionAPI) => {
          api = pi;
          return originalFactory(pi);
        } };
      });
      return { ...composition, extensionFactories: boundFactories,
        lifecycle: {
          capture: session => composition.lifecycle.capture(session),
          publish: (session, runner) => composition.lifecycle.publish(session, runner),
          fence: (session, reason) => {
            composition.lifecycle.fence(session, reason);
            consentManager.clear();
          },
        },
        failStartup: error => { composition.failStartup(error); consentManager.clear(); },
      };
    } catch (error) {
      host.close();
      consentManager.clear();
      this.#children.delete(host);
      throw error;
    }
  }

  close(): void {
    this.#closed = true;
    for (const [host, consent] of this.#children) { host.close(); consent?.clear(); }
    this.#children.clear();
  }
}

/** Final stable/experimental engine entry may select this export after policy/type/runtime gates.
 * Caller supplies original argv/MainOptions, not internal App consent/viewer/transport fields.
 */
export async function runOwnedDefaultMain(args: string[], mainOptions?: MainOptions): Promise<void> {
  const host = new OwnedDefaultHost();
  try { await hostedMain(args, mainOptions, host); }
  finally { host.close(); }
}
