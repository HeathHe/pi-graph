/** Owned build-only entry contracts, NOT additions to stock package exports.
 * Bodies are the exact existing canonical SDK modules, enforced by PATCH-SPEC SHA.
 */
declare module "m18:owned-prompts" {
  export function loadPromptTemplates(options: { cwd: string; agentDir: string; promptPaths: string[]; includeDefaults: boolean }): {
    templates: ReturnType<import("@earendil-works/pi-coding-agent").ResourceLoader["getPrompts"]>["prompts"];
    diagnostics: ReturnType<import("@earendil-works/pi-coding-agent").ResourceLoader["getPrompts"]>["diagnostics"];
  };
}
declare module "m18:owned-theme" {
  export function loadThemeFromPath(themePath: string, mode?: ReturnType<import("@earendil-works/pi-coding-agent").Theme["getColorMode"]>): import("@earendil-works/pi-coding-agent").Theme;
}
declare module "m18:owned-source-info" {
  export function createSourceInfo(path: string, metadata: import("@earendil-works/pi-coding-agent").PathMetadata): import("@earendil-works/pi-coding-agent").SourceInfo;
}
declare module "m18:native-mcp-transport" {
  export const createDefaultTransport: import("@earendil-works/pi-coding-agent").McpTransportFactory;
}

declare module "m18:owned-extension-policy" {
  export function loadOwnedExtensionSet(options: {
    cwd: string;
    eventBus: import("@earendil-works/pi-coding-agent").EventBus;
    extensionPaths: readonly string[];
    extensionFactories: readonly import("@earendil-works/pi-coding-agent").InlineExtension[];
    builtinNames: readonly string[];
    clearCache?: boolean;
  }): Promise<import("@earendil-works/pi-coding-agent").LoadExtensionsResult>;
}

/** Exact owned source module selected only by the version-bound CLI import seam. */
declare module "m18:owned-default-launcher" {
  export function runOwnedDefaultMain(args: string[], mainOptions?: import("@earendil-works/pi-coding-agent").MainOptions): Promise<void>;
}
