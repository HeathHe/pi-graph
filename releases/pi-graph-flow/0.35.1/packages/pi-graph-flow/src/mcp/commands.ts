import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SupportedSettingsLocale } from "pi-maestro-settings-core/v1";
import { getTuiLocale } from "../tui/locale.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpAuthResult, McpConfig, ServerEntry, McpPanelCallbacks, McpPanelResult, ImportKind } from "./types.ts";
import {
  ensureCompatibilityImports,
  getMcpDiscoverySummary,
  getServerProvenance,
  previewCompatibilityImports,
  previewSharedServerEntry,
  previewStarterProjectConfig,
  writeDirectToolsConfig,
  writeSharedServerEntry,
  writeStarterProjectConfig,
} from "./config.ts";
import { lazyConnect, updateMetadataCache, updateStatusBar, getFailureAgeSeconds } from "./init.ts";
import { loadMetadataCache } from "./metadata-cache.ts";
import { buildToolMetadata } from "./tool-metadata.ts";
import { supportsOAuth, authenticate, removeAuth } from "./mcp-auth-flow.ts";
import { getAuthForUrl } from "./mcp-auth.ts";
import { loadOnboardingState, markSetupCompleted as persistSetupCompleted, markSharedConfigHintShown } from "./onboarding-state.ts";
import { openPath } from "./utils.ts";
import { McpManagerStore, type McpConfigScope } from "./mcp-manager-store.ts";
import {
  normalizeHttpUrl,
  parseStringArray,
  parseStringRecord,
  runMcpManager,
  validateMcpServerEntry,
} from "./mcp-manager-flow.ts";
import {
  extractHeadlessArgs,
  headlessField,
  parseHeadlessBoolean,
  parseHeadlessList,
  splitCommandArgs,
} from "../tui/headless-args.ts";
import { supportsCustomOverlay } from "pi-maestro-settings-core/ui";

const COMMAND_CATALOGS = {
  en: {
    "shared.using": "Using standard MCP config from {sources}.",
    "shared.writes": "Pi only writes compatibility imports and adapter-specific overrides into Pi-owned files when needed.",
    "setup.repoUnavailable": "RepoPrompt is not available to add from this setup screen.",
    "panel.directUpdated": "Direct tools updated. Pi will reload after this panel closes.",
    "auth.none": "No OAuth-capable MCP servers are configured.",
    "auth.instructions": "Select an OAuth MCP server and press Enter or ctrl+a to authenticate.",
    "auth.interactive": "OAuth authentication requires an interactive session.",
    "auth.serverMissing": "Server \"{name}\" was not found in the configuration",
    "auth.unsupported": "Server \"{name}\" does not use OAuth authentication. Set \"auth\": \"oauth\" or omit auth for auto-detection.",
    "auth.noUrl": "Server \"{name}\" has no URL configured (OAuth requires HTTP transport)",
    "auth.status": "Authenticating {name}...",
    "auth.openUrl": "Open this URL to authenticate {name}:\n\n{url}\n\nAfter approving, return to Pi; the local callback will complete automatically.",
    "auth.success": "OAuth authentication successful for \"{name}\"! Run /mcp reconnect {name} to connect with the new token.",
    "auth.failed": "OAuth authentication failed for \"{name}\".",
    "auth.error": "Failed to authenticate \"{name}\": {message}",
    "auth.cleared": "OAuth credentials cleared for \"{name}\". Run /mcp auth {name} to authenticate again.",
  },
  "zh-CN": {
    "shared.using": "正在使用来自 {sources} 的标准 MCP 配置。",
    "shared.writes": "Pi 仅在需要时将兼容导入和适配器专用覆盖写入 Pi 自有文件。",
    "setup.repoUnavailable": "此设置界面无法添加 RepoPrompt。",
    "panel.directUpdated": "直连工具已更新。面板关闭后 Pi 将重载。",
    "auth.none": "未配置支持 OAuth 的 MCP 服务。",
    "auth.instructions": "选择 OAuth MCP 服务，然后按 Enter 或 ctrl+a 认证。",
    "auth.interactive": "OAuth 认证需要交互式会话。",
    "auth.serverMissing": "配置中未找到服务“{name}”",
    "auth.unsupported": "服务“{name}”未使用 OAuth 认证。请设置 \"auth\": \"oauth\"，或省略 auth 以自动检测。",
    "auth.noUrl": "服务“{name}”未配置 URL（OAuth 需要 HTTP 传输）",
    "auth.status": "正在认证 {name}...",
    "auth.openUrl": "打开以下 URL 认证 {name}：\n\n{url}\n\n批准后返回 Pi；本地回调会自动完成。",
    "auth.success": "“{name}”的 OAuth 认证成功！运行 /mcp reconnect {name} 使用新 Token 连接。",
    "auth.failed": "“{name}”的 OAuth 认证失败。",
    "auth.error": "认证“{name}”失败：{message}",
    "auth.cleared": "已清除“{name}”的 OAuth 凭据。运行 /mcp auth {name} 重新认证。",
  },
} as const;

type CommandCatalogKey = keyof (typeof COMMAND_CATALOGS)["en"];

function commandText(
  key: CommandCatalogKey,
  vars?: Readonly<Record<string, string | number>>,
  explicitLocale?: SupportedSettingsLocale,
): string {
  const locale = getTuiLocale(explicitLocale);
  const template = COMMAND_CATALOGS[locale]?.[key] ?? COMMAND_CATALOGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`);
}

export async function showStatus(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const lines: string[] = ["MCP Server Status:", ""];

  for (const name of Object.keys(state.config.mcpServers)) {
    const connection = state.manager.getConnection(name);
    const metadata = state.toolMetadata.get(name);
    const toolCount = metadata?.length ?? 0;
    const failedAgo = getFailureAgeSeconds(state, name);
    let status = "not connected";
    let statusIcon = "○";
    let failed = false;

    if (connection?.status === "connected") {
      status = "connected";
      statusIcon = "✓";
    } else if (connection?.status === "needs-auth") {
      status = "needs auth";
      statusIcon = "⚠";
    } else if (failedAgo !== null) {
      status = `failed ${failedAgo}s ago`;
      statusIcon = "✗";
      failed = true;
    } else if (metadata !== undefined) {
      status = "cached";
    }

    const toolSuffix = failed ? "" : ` (${toolCount} tools${status === "cached" ? ", cached" : ""})`;
    lines.push(`${statusIcon} ${name}: ${status}${toolSuffix}`);
  }

  if (Object.keys(state.config.mcpServers).length === 0) {
    lines.push("No MCP servers configured");
    lines.push("Run /mcp setup to adopt imports or scaffold a starter .mcp.json");
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function showTools(state: McpExtensionState, ctx: ExtensionContext): Promise<void> {
  if (!ctx.hasUI) return;

  const allTools = [...state.toolMetadata.values()].flat().map(m => m.name);

  if (allTools.length === 0) {
    ctx.ui.notify("No MCP tools available", "info");
    return;
  }

  const lines = [
    "MCP Tools:",
    "",
    ...allTools.map(t => `  ${t}`),
    "",
    `Total: ${allTools.length} tools`,
  ];

  ctx.ui.notify(lines.join("\n"), "info");
}

export async function reconnectServers(
  state: McpExtensionState,
  ctx: ExtensionContext,
  targetServer?: string
): Promise<void> {
  if (targetServer && !state.config.mcpServers[targetServer]) {
    if (ctx.hasUI) {
      ctx.ui.notify(`Server "${targetServer}" not found in config`, "error");
    }
    return;
  }

  const entries = targetServer
    ? [[targetServer, state.config.mcpServers[targetServer]] as [string, ServerEntry]]
    : Object.entries(state.config.mcpServers);

  for (const [name, definition] of entries) {
    try {
      await state.manager.close(name);

      const connection = await state.manager.connect(name, definition);
      if (connection.status === "needs-auth") {
        if (ctx.hasUI) {
          ctx.ui.notify(`MCP: ${name} requires OAuth. Run /mcp auth ${name} first.`, "warning");
        }
        continue;
      }
      const prefix = state.config.settings?.toolPrefix ?? "server";

      const { metadata, failedTools } = buildToolMetadata(connection.tools, connection.resources, definition, name, prefix);
      state.toolMetadata.set(name, metadata);
      updateMetadataCache(state, name);
      state.failureTracker.delete(name);

      if (ctx.hasUI) {
        ctx.ui.notify(
          `MCP: Reconnected to ${name} (${connection.tools.length} tools, ${connection.resources.length} resources)`,
          "info"
        );
        if (failedTools.length > 0) {
          ctx.ui.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.failureTracker.set(name, Date.now());
      if (ctx.hasUI) {
        ctx.ui.notify(`MCP: Failed to reconnect to ${name}: ${message}`, "error");
      }
    }
  }

  updateStatusBar(state);
}

export async function authenticateServer(
  serverName: string,
  config: McpConfig,
  ctx: ExtensionContext,
  locale?: SupportedSettingsLocale,
): Promise<McpAuthResult> {
  if (!ctx.hasUI) return { ok: false, message: commandText("auth.interactive", undefined, locale) };

  const definition = config.mcpServers[serverName];
  if (!definition) {
    const message = commandText("auth.serverMissing", { name: serverName }, locale);
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  if (!supportsOAuth(definition)) {
    const message = commandText("auth.unsupported", { name: serverName }, locale);
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  if (!definition.url) {
    const message = commandText("auth.noUrl", { name: serverName }, locale);
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  try {
    ctx.ui.setStatus("mcp-auth", commandText("auth.status", { name: serverName }, locale));
    const status = await authenticate(serverName, definition.url, definition, {
      onAuthorizationUrl: (authorizationUrl) => {
        ctx.ui.notify(commandText("auth.openUrl", { name: serverName, url: authorizationUrl }, locale), "info");
      },
    });

    if (status === "authenticated") {
      const message = commandText("auth.success", { name: serverName }, locale);
      ctx.ui.notify(message, "info");
      return { ok: true, message };
    }

    const message = commandText("auth.failed", { name: serverName }, locale);
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    const message = commandText("auth.error", { name: serverName, message: failure }, locale);
    ctx.ui.notify(message, "error");
    return { ok: false, message };
  } finally {
    ctx.ui.setStatus("mcp-auth", undefined);
  }
}

export async function logoutServer(
  serverName: string,
  state: McpExtensionState,
  ctx: ExtensionContext,
  locale?: SupportedSettingsLocale,
): Promise<{ ok: boolean; message: string }> {
  const definition = state.config.mcpServers[serverName];
  if (!definition) {
    const message = commandText("auth.serverMissing", { name: serverName }, locale);
    if (ctx.hasUI) ctx.ui.notify(message, "error");
    return { ok: false, message };
  }

  await removeAuth(serverName);
  await state.manager.close(serverName);
  updateStatusBar(state);

  const message = commandText("auth.cleared", { name: serverName }, locale);
  if (ctx.hasUI) ctx.ui.notify(message, "info");
  return { ok: true, message };
}

export interface PanelFlowResult {
  configChanged: boolean;
}

function buildSharedConfigNoticeLines(
  configOverridePath: string | undefined,
  cwd: string,
  locale?: SupportedSettingsLocale,
): { lines: string[]; fingerprint: string | null } {
  const discovery = getMcpDiscoverySummary(configOverridePath, cwd);
  const onboardingState = loadOnboardingState();
  if (!discovery.hasSharedServers || onboardingState.sharedConfigHintShown) {
    return { lines: [], fingerprint: null };
  }

  const sharedSources = discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0);
  const sourceList = sharedSources.map((source) => source.path).join(", ");
  return {
    lines: [
      commandText("shared.using", { sources: sourceList }, locale),
      commandText("shared.writes", undefined, locale),
    ],
    fingerprint: discovery.fingerprint,
  };
}

export async function openMcpSetup(
  _state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  mode: "empty" | "setup" = "setup",
  locale?: SupportedSettingsLocale,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const discovery = getMcpDiscoverySummary(configOverridePath, ctx.cwd);
  const onboardingState = loadOnboardingState();
  const { createMcpSetupPanel } = await import("./mcp-setup-panel.ts");
  let configChanged = false;

  const callbacks = {
    previewImports: (imports: ImportKind[]) => previewCompatibilityImports(imports, configOverridePath),
    previewStarterProject: () => previewStarterProjectConfig(ctx.cwd),
    previewRepoPrompt: () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) return null;
      return previewSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
    },
    adoptImports: async (imports: ImportKind[]) => {
      const result = ensureCompatibilityImports(imports, configOverridePath);
      if (result.added.length > 0) configChanged = true;
      return result;
    },
    scaffoldProjectConfig: async () => {
      const path = writeStarterProjectConfig(ctx.cwd);
      configChanged = true;
      return { path };
    },
    addRepoPrompt: async () => {
      const repoPrompt = getMcpDiscoverySummary(configOverridePath, ctx.cwd).repoPrompt;
      if (!repoPrompt.entry || !repoPrompt.targetPath || !repoPrompt.serverName) {
        throw new Error(commandText("setup.repoUnavailable", undefined, locale));
      }
      const path = writeSharedServerEntry(repoPrompt.targetPath, repoPrompt.serverName, repoPrompt.entry);
      configChanged = true;
      return { path, serverName: repoPrompt.serverName };
    },
    openPath: async (targetPath: string) => {
      await openPath(pi, targetPath);
    },
    markSetupCompleted: () => {
      persistSetupCompleted(discovery.fingerprint);
    },
  };

  return new Promise<PanelFlowResult>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpSetupPanel(discovery, callbacks, {
          mode,
          onboardingState,
          keybindings,
          locale: getTuiLocale(locale),
        }, tui, () => {
          done(undefined);
          resolve({ configChanged });
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "94%" } },
    );
  });
}

function buildMcpPanelCallbacks(
  state: McpExtensionState,
  config: McpConfig,
  ctx: ExtensionContext,
  locale?: SupportedSettingsLocale,
): McpPanelCallbacks {
  return {
    reconnect: (serverName: string) => lazyConnect(state, serverName),
    canAuthenticate: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      return definition ? supportsOAuth(definition) : false;
    },
    authenticate: (serverName: string) => authenticateServer(serverName, config, ctx, locale),
    getConnectionStatus: (serverName: string) => {
      const definition = config.mcpServers[serverName];
      const connection = state.manager.getConnection(serverName);
      if (connection?.status === "needs-auth") {
        return "needs-auth";
      }
      if (
        definition?.auth === "oauth"
        && definition.url
        && definition.oauth !== false
        && definition.oauth?.grantType !== "client_credentials"
        && !getAuthForUrl(serverName, definition.url)?.tokens
      ) {
        return "needs-auth";
      }
      if (connection?.status === "connected") return "connected";
      if (getFailureAgeSeconds(state, serverName) !== null) return "failed";
      return "idle";
    },
    refreshCacheAfterReconnect: (serverName: string) => {
      const freshCache = loadMetadataCache();
      return freshCache?.servers?.[serverName] ?? null;
    },
  };
}

export async function openMcpManager(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  locale?: SupportedSettingsLocale,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const callbacks = buildMcpPanelCallbacks(state, state.config, ctx, locale);
  const store = new McpManagerStore(ctx.cwd, configPath);
  return runMcpManager(ctx, store, {
    status: (serverName) => callbacks.getConnectionStatus(serverName),
    toolNames: (serverName) => (state.toolMetadata.get(serverName) ?? []).map((tool) => tool.originalName),
    canAuthenticate: (serverName) => callbacks.canAuthenticate(serverName),
    authenticate: (serverName) => callbacks.authenticate(serverName),
  }, locale);
}

export async function openMcpPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  locale?: SupportedSettingsLocale,
): Promise<PanelFlowResult> {
  if (Object.keys(state.config.mcpServers).length === 0) {
    return openMcpSetup(state, pi, ctx, configOverridePath, "empty", locale);
  }

  const config = state.config;
  const cache = loadMetadataCache();
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const { lines: noticeLines, fingerprint } = buildSharedConfigNoticeLines(configPath, ctx.cwd, locale);

  const callbacks = buildMcpPanelCallbacks(state, config, ctx, locale);

  const { createMcpPanel } = await import("./mcp-panel.ts");
  let configChanged = false;

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, (result: McpPanelResult) => {
          if (!result.cancelled && result.changes.size > 0) {
            writeDirectToolsConfig(result.changes, provenanceMap, config);
            configChanged = true;
            ctx.ui.notify(commandText("panel.directUpdated", undefined, locale), "info");
          }
          done(undefined);
          resolve();
        }, { noticeLines, keybindings, getTerminalRows: () => tui.terminal?.rows, locale: getTuiLocale(locale) });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" } },
    );
  });

  if (noticeLines.length > 0 && fingerprint) {
    markSharedConfigHintShown(fingerprint);
  }

  return { configChanged };
}

export async function openMcpAuthPanel(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath?: string,
  locale?: SupportedSettingsLocale,
): Promise<PanelFlowResult> {
  if (!ctx.hasUI) return { configChanged: false };

  const config = state.config;
  const oauthServers = Object.entries(config.mcpServers).filter(([, definition]) => supportsOAuth(definition));
  if (oauthServers.length === 0) {
    ctx.ui.notify(commandText("auth.none", undefined, locale), "warning");
    return { configChanged: false };
  }

  const cache = loadMetadataCache();
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const provenanceMap = getServerProvenance(configPath, ctx.cwd);
  const callbacks = buildMcpPanelCallbacks(state, config, ctx, locale);
  const { createMcpPanel } = await import("./mcp-panel.ts");

  await new Promise<void>((resolve) => {
    ctx.ui.custom(
      (tui, _theme, keybindings, done) => {
        return createMcpPanel(config, cache, provenanceMap, callbacks, tui, () => {
          done(undefined);
          resolve();
        }, {
          authOnly: true,
          keybindings,
          getTerminalRows: () => tui.terminal?.rows,
          locale: getTuiLocale(locale),
          noticeLines: [commandText("auth.instructions", undefined, locale)],
        });
      },
      { overlay: true, overlayOptions: { anchor: "center", width: "94%", maxHeight: "92%" } },
    );
  });

  return { configChanged: false };
}

const MCP_HEADLESS_USAGE =
  "用法：/mcp [status|list|add|edit <name>|delete <name> [--yes]|enable <name>|disable <name>|reconnect [name]|auth <name>|logout <name>|tools]；add/edit 字段：--name=.. --scope=user|project --command=..|--url=.. --args=<json> --env=<json> --headers=<json> --auth=oauth|bearer|none --bearer-token=.. --lifecycle=lazy|keep-alive|eager --idle-timeout=<min> --request-timeout-ms=<ms> --expose-resources=on|off --direct-tools=on|off|a,b --exclude-tools=a,b --enabled=on|off --debug=on|off --cwd=..";

/** 将 --field=value 合并进 ServerEntry；edit 时基于 existing 合并，缺省字段保持原值。 */
function mcpServerEntryFromHeadless(
  fields: Record<string, string>,
  existing: ServerEntry | undefined,
): { entry: ServerEntry } | { error: string } {
  const entry: ServerEntry = { ...(existing ?? {}) };
  try {
    const command = headlessField(fields, "command", "cmd");
    if (command !== undefined) {
      entry.command = command;
      delete entry.url;
    }
    const url = headlessField(fields, "url", "endpoint");
    if (url !== undefined) {
      entry.url = normalizeHttpUrl(url);
      delete entry.command;
    }
    const args = headlessField(fields, "args");
    if (args !== undefined) entry.args = parseStringArray(args, "--args");
    const env = headlessField(fields, "env");
    if (env !== undefined) entry.env = parseStringRecord(env, "--env");
    const headers = headlessField(fields, "headers");
    if (headers !== undefined) entry.headers = parseStringRecord(headers, "--headers");
    const cwd = headlessField(fields, "cwd", "workdir");
    if (cwd !== undefined) entry.cwd = cwd;
    const auth = headlessField(fields, "auth");
    if (auth !== undefined) {
      const normalized = auth.trim().toLowerCase();
      if (normalized === "oauth" || normalized === "bearer") entry.auth = normalized;
      else if (["none", "off", "false", "disabled"].includes(normalized)) entry.auth = false;
      else return { error: "--auth expects oauth|bearer|none" };
    }
    const bearerToken = headlessField(fields, "bearerToken", "bearer-token", "token");
    if (bearerToken !== undefined) entry.bearerToken = bearerToken;
    const bearerTokenEnv = headlessField(fields, "bearerTokenEnv", "bearer-token-env");
    if (bearerTokenEnv !== undefined) entry.bearerTokenEnv = bearerTokenEnv;
    const lifecycle = headlessField(fields, "lifecycle");
    if (lifecycle !== undefined) {
      const normalized = lifecycle.trim().toLowerCase();
      if (normalized !== "lazy" && normalized !== "keep-alive" && normalized !== "eager") {
        return { error: "--lifecycle expects lazy|keep-alive|eager" };
      }
      entry.lifecycle = normalized;
    }
    const idleTimeout = headlessField(fields, "idleTimeout", "idle-timeout");
    if (idleTimeout !== undefined) {
      const value = Number(idleTimeout.trim());
      if (!Number.isFinite(value) || value <= 0) return { error: "--idle-timeout must be a positive number (minutes)" };
      entry.idleTimeout = value;
    }
    const requestTimeoutMs = headlessField(fields, "requestTimeoutMs", "request-timeout-ms", "timeoutMs", "timeout-ms");
    if (requestTimeoutMs !== undefined) {
      const value = Number(requestTimeoutMs.trim());
      if (!Number.isSafeInteger(value) || value <= 0) return { error: "--request-timeout-ms must be a positive integer" };
      entry.requestTimeoutMs = value;
    }
    for (const [names, apply] of [
      [["exposeResources", "expose-resources"], (parsed: boolean) => { entry.exposeResources = parsed; }],
      [["debug"], (parsed: boolean) => { entry.debug = parsed; }],
      [["enabled"], (parsed: boolean) => { entry.enabled = parsed; }],
    ] as const) {
      const raw = headlessField(fields, ...names);
      if (raw === undefined) continue;
      const parsed = parseHeadlessBoolean(raw);
      if (parsed === undefined) return { error: `--${names[names.length - 1]} expects on|off` };
      apply(parsed);
    }
    const directTools = headlessField(fields, "directTools", "direct-tools");
    if (directTools !== undefined) {
      const parsed = parseHeadlessBoolean(directTools);
      entry.directTools = parsed !== undefined ? parsed : parseHeadlessList(directTools);
    }
    const excludeTools = headlessField(fields, "excludeTools", "exclude-tools");
    if (excludeTools !== undefined) entry.excludeTools = parseHeadlessList(excludeTools);
    validateMcpServerEntry(entry);
    return { entry };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export interface McpHeadlessResult {
  handled: boolean;
  configChanged: boolean;
}

/**
 * /mcp 的 headless 配置路径：所有写入经过 McpManagerStore（与 manager overlay 同一套
 * 原子写+锁），成功后由调用方 ctx.reload() 让新配置在进程内生效。
 */
export async function runMcpHeadless(
  state: McpExtensionState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configOverridePath: string | undefined,
  subcommand: string,
  rest: string[],
  fields: Record<string, string>,
  locale?: SupportedSettingsLocale,
): Promise<McpHeadlessResult> {
  const configPath = pi.getFlag("mcp-config") as string | undefined ?? configOverridePath;
  const store = new McpManagerStore(ctx.cwd, configPath);
  const nameArg = rest[0] ?? headlessField(fields, "name", "server");
  const assumeYes = parseHeadlessBoolean(headlessField(fields, "yes") ?? "") === true;
  const findServer = (snapshot: Awaited<ReturnType<McpManagerStore["load"]>>, name: string | undefined) => {
    const server = name ? snapshot.servers.find((candidate) => candidate.name === name) : undefined;
    if (!server) ctx.ui.notify(`MCP server not found: ${name ?? "(missing)"}`, "warning");
    return server;
  };

  try {
    switch (subcommand) {
      case "list": {
        const snapshot = await store.load();
        const lines = snapshot.servers.map((server) => {
          const target = server.entry.command ?? server.entry.url ?? "?";
          return `${server.entry.enabled === false ? "off" : "on "} ${server.name} [${server.scope}] ${target}`;
        });
        ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No MCP servers configured", "info");
        return { handled: true, configChanged: false };
      }
      case "add":
      case "set":
      case "edit": {
        const editing = subcommand !== "add";
        const snapshot = await store.load();
        const existing = editing ? findServer(snapshot, nameArg) : snapshot.servers.find((server) => server.name === nameArg);
        if (editing && !existing) return { handled: true, configChanged: false };
        const name = nameArg ?? existing?.name;
        if (!name) {
          ctx.ui.notify(MCP_HEADLESS_USAGE, "warning");
          return { handled: true, configChanged: false };
        }
        const built = mcpServerEntryFromHeadless(fields, existing?.entry);
        if ("error" in built) {
          ctx.ui.notify(`${built.error}\n${MCP_HEADLESS_USAGE}`, "warning");
          return { handled: true, configChanged: false };
        }
        const scopeRaw = headlessField(fields, "scope")?.toLowerCase();
        if (scopeRaw !== undefined && scopeRaw !== "user" && scopeRaw !== "project") {
          ctx.ui.notify("--scope expects user|project", "warning");
          return { handled: true, configChanged: false };
        }
        const scope: McpConfigScope = scopeRaw === "project" || scopeRaw === "user"
          ? scopeRaw
          : existing?.scope === "project" ? "project" : "user";
        await store.save({
          previousName: existing && !existing.readOnly ? existing.name : undefined,
          name,
          entry: built.entry,
          scope,
          allowImportedOverride: existing?.readOnly === true || assumeYes,
        });
        ctx.ui.notify(`${editing ? "Updated" : "Added"} MCP server "${name}" (${scope}) · reload 后生效`, "info");
        return { handled: true, configChanged: true };
      }
      case "delete":
      case "remove": {
        const snapshot = await store.load();
        const server = findServer(snapshot, nameArg);
        if (!server) return { handled: true, configChanged: false };
        const confirmed = assumeYes || await ctx.ui.confirm(
          `Delete MCP server "${server.name}"?`,
          `This removes the server from the ${server.scope} configuration:\n${server.path}`,
        );
        if (!confirmed) return { handled: true, configChanged: false };
        await store.delete(server);
        ctx.ui.notify(`Deleted MCP server "${server.name}" · reload 后生效`, "info");
        return { handled: true, configChanged: true };
      }
      case "enable":
      case "disable": {
        const snapshot = await store.load();
        const server = findServer(snapshot, nameArg);
        if (!server) return { handled: true, configChanged: false };
        const want = subcommand === "enable";
        if ((server.entry.enabled !== false) === want) {
          ctx.ui.notify(`MCP server "${server.name}" already ${want ? "enabled" : "disabled"}`, "info");
          return { handled: true, configChanged: false };
        }
        await store.save({
          previousName: server.readOnly ? undefined : server.name,
          name: server.name,
          entry: { ...server.entry, enabled: want },
          scope: server.scope === "project" ? "project" : "user",
          allowImportedOverride: server.readOnly,
        });
        ctx.ui.notify(`${want ? "Enabled" : "Disabled"} MCP server "${server.name}" · reload 后生效`, "info");
        return { handled: true, configChanged: true };
      }
      default:
        return { handled: false, configChanged: false };
    }
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return { handled: true, configChanged: false };
  }
}
