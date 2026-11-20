/** Domain tags for tool expertise matching. */
export declare const DOMAIN_TAGS: readonly ["frontend", "backend", "fullstack", "devops", "data", "mobile", "infra"];
export type DomainTag = (typeof DOMAIN_TAGS)[number];
/** Reasoning effort levels for thinking models. */
export declare const REASONING_EFFORTS: readonly ["low", "medium", "high", "max"];
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export interface ToolEntry {
    enabled: boolean;
    primaryModel: string;
    secondaryModel?: string;
    /** Domain expertise tags (frontend, backend, fullstack, etc.) — used by execute for tool selection */
    tags: string[];
    type: string;
    /** Settings file path for the CLI tool (e.g. Claude --settings, Codex --profile) */
    settingsFile?: string;
    /** Base tool name for aliases (e.g. "claude" for "claude-analysis") */
    baseTool?: string;
    /** Reasoning effort level (undefined = tool default).
     *  Translated per-adapter: Claude → --effort, Codex → -c reasoning.effort. */
    reasoningEffort?: ReasoningEffort;
    /** Stale-stream silence window in ms before force-terminating a silent CLI
     *  (undefined = adapter default, 10 min). Overridden by `delegate --timeout`. */
    streamTimeoutMs?: number;
    /** Per-tool proxy toggle. true = inherit global proxy, false = skip proxy for this tool. */
    proxy?: boolean;
}
export interface ProxyConfig {
    enabled: boolean;
    /** HTTP proxy URL (e.g. "http://127.0.0.1:7890") */
    httpProxy?: string;
    /** HTTPS proxy URL (defaults to httpProxy if omitted) */
    httpsProxy?: string;
    /** Comma-separated bypass list (e.g. "127.0.0.1,localhost") */
    noProxy?: string;
}
export interface RoleMapping {
    /** Direct tool name (simplest config) */
    tool?: string;
    /** Ordered fallback tool names */
    fallbackChain?: string[];
}
export interface CliToolsConfig {
    version: string;
    tools: Record<string, ToolEntry>;
    /** User-configurable role → tool mappings */
    roles?: Record<string, RoleMapping>;
    /** Global proxy configuration — injected into CLI subprocess env before spawn */
    proxy?: ProxyConfig;
}
/** Fixed set of supported roles. */
export declare const DELEGATE_ROLES: readonly ["analyze", "explore", "review", "implement", "plan", "brainstorm", "research"];
export type DelegateRole = (typeof DELEGATE_ROLES)[number];
/**
 * Load CLI tools configuration with workspace-level overrides.
 *
 * Priority: {workDir}/.maestro/cli-tools.json > ~/.maestro/cli-tools.json > DEFAULT_CONFIG
 *
 * Merge strategy:
 * - tools: deep merge (workspace overrides same-name tools)
 * - roles: deep merge (workspace overrides same-name roles)
 */
export declare function loadCliToolsConfig(workDir?: string): Promise<CliToolsConfig>;
export interface SelectedTool {
    name: string;
    entry: ToolEntry;
}
/**
 * Select a tool by explicit name or fall back to the first enabled tool.
 * Returns undefined when no tool can be resolved.
 */
export declare function selectTool(name: string | undefined, config: CliToolsConfig): SelectedTool | undefined;
/**
 * Select a tool by capability role.
 *
 * Resolution order:
 * 1. User-configured role mapping (config.roles[role])
 * 2. Built-in default role mapping (DEFAULT_ROLE_MAPPINGS[role])
 * 3. If mapping has `tool` → direct selectTool()
 * 4. Walk `fallbackChain` → first enabled tool in chain
 * 5. Last resort → selectTool(undefined) (first enabled)
 */
export declare function selectToolByRole(role: string, config: CliToolsConfig): SelectedTool | undefined;
/**
 * Save CLI tools configuration to a specific scope.
 * Reads existing config, deep-merges the update, and writes back.
 */
export declare function saveCliToolsConfig(update: Partial<CliToolsConfig>, scope: 'global' | 'workspace', workDir?: string): Promise<void>;
/** Expose default role mappings for TUI display. */
export declare function getDefaultRoleMappings(): Record<string, RoleMapping>;
/**
 * Rank enabled tools by domain tag relevance.
 * Returns tools sorted: exact tag match first, then fullstack, then rest.
 * Used by `maestro execute` to suggest the best tool for a task domain.
 */
export declare function rankToolsByDomain(domain: string, config: CliToolsConfig): SelectedTool[];
/**
 * Build proxy environment variable overrides for a specific tool.
 * Returns an empty object when proxy is disabled globally or for the tool.
 * Proxy priority: api.json → api-explore.json → cli-tools.json config.proxy.
 */
export declare function resolveProxyEnv(config: CliToolsConfig, toolName: string): Record<string, string>;
/**
 * Quick TCP probe to check if the proxy is reachable.
 * Returns true if a connection can be established within the timeout.
 */
export declare function checkProxyReachable(proxyUrl: string, timeoutMs?: number): Promise<boolean>;
/** Load global and workspace configs separately (un-merged) for introspection. */
export declare function loadConfigSources(workDir?: string): Promise<{
    globalPath: string;
    global: Partial<CliToolsConfig> | null;
    workspacePath: string | null;
    workspace: Partial<CliToolsConfig> | null;
}>;
/**
 * Reset ~/.maestro/cli-tools.json to defaults.
 * Re-detects CLI availability and overwrites the existing file.
 * Returns the new config.
 */
export declare function resetCliToolsConfig(): Promise<CliToolsConfig>;
export interface InitResult {
    /** Whether the file was created or modified. */
    changed: boolean;
    /** Tool names newly added (empty for first-time create or no-op). */
    added: string[];
    /** True when the file did not exist before this call. */
    created: boolean;
}
/**
 * Initialize / upgrade ~/.maestro/cli-tools.json.
 *
 * - First install (file missing): create from defaults with availability detection.
 * - Upgrade (file present): merge defaults into existing — only adds tools that
 *   are missing. Existing entries (primaryModel, secondaryModel, settingsFile,
 *   reasoningEffort, tags, enabled) are preserved verbatim.
 *
 * Returns details about what changed.
 */
export declare function initCliToolsConfig(): Promise<InitResult>;
/**
 * Synchronous version of initCliToolsConfig for non-async contexts (e.g. forceInstall).
 * Same semantics: first-install creates, upgrade merges only missing tool defs.
 */
export declare function initCliToolsConfigSync(): InitResult;
//# sourceMappingURL=cli-tools-config.d.ts.map