import { main as hostedMain } from "m18:hosted-main";
import type { AgentSession, ExtensionRunner, MainOptions, ResourceLoader } from "./sdk-types.js";
import type { RuntimeInput, RuntimeComposition, TrustedHostOptions } from "./host-types.js";
import { createNativeAppBridge, type NativeAppBridgeOptions } from "../mcp/native-app-bridge.ts";
import { createDefaultTransport } from "m18:native-mcp-transport";
import type { McpTransportFactory } from "@earendil-works/pi-coding-agent";
import { HostSessionScope } from "./session-scope.js";

export interface HostLaunchOptions {
  // Trusted composition only. Ordinary CLI leaves this absent and retains default resources.
  nativeApp?: Omit<NativeAppBridgeOptions, "host" | "createTransport"> & { createTransport?: McpTransportFactory };
  createResourceLoader?: (input: RuntimeInput) => ResourceLoader;
}
export class HostRoot implements TrustedHostOptions {
  #scopes = new Set<HostSessionScope<ExtensionRunner, AgentSession>>();
  #closed = false;
  constructor(private readonly options: HostLaunchOptions = {}) {}
  prepareRuntime(input: RuntimeInput): RuntimeComposition {
    if (this.#closed) throw new Error("M18 host has closed");
    const scope = new HostSessionScope<ExtensionRunner, AgentSession>();
    this.#scopes.add(scope);
    try {
      let extensionFactories = input.extensionFactories;
      if (this.options.nativeApp) {
        const matches = extensionFactories.filter(entry => typeof entry !== "function" && entry.builtin === true && entry.name === "mcp");
        if (matches.length !== 1) throw new Error("Expected exactly one original builtin:mcp factory slot");
        const target = matches[0];
        const bridge = createNativeAppBridge({ ...this.options.nativeApp, host: scope,
          createTransport: this.options.nativeApp.createTransport ?? createDefaultTransport });
        extensionFactories = extensionFactories.map(entry => entry === target && typeof entry !== "function"
          ? { ...entry, factory: bridge.factory } : entry);
      }
      const resourceLoader = this.options.createResourceLoader?.(this.options.nativeApp ? { ...input, extensionFactories } : input);
      return {
        lifecycle: scope,
        ...(this.options.nativeApp ? { extensionFactories } : {}),
        ...(resourceLoader === undefined ? {} : { resourceLoader }),
        failStartup: (error: unknown) => scope.failStartup(error),
      };
    } catch (error) {
      scope.failStartup(error);
      throw error;
    }
  }
  close(): void {
    this.#closed = true;
    for (const scope of this.#scopes) scope.close();
    this.#scopes.clear();
  }
}
export async function runHostedMain(args: string[], mainOptions?: MainOptions, options?: HostLaunchOptions): Promise<void> {
  const host = new HostRoot(options);
  try {
    // Original argv, MainOptions, extension ordering, parser, modes, and recovery remain in main.
    await hostedMain(args, mainOptions, host);
  } finally {
    // Admission only; do not invent SDK native cleanup for a main early-return branch.
    host.close();
  }
}
