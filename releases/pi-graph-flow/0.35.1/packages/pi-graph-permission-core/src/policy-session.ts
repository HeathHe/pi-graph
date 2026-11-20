import { createOperationFence } from "./lifecycle-ports.ts";
import type { PermissionBehavior, PermissionMode, PermissionRuleSettings, PermissionToolCall, PermissionUpdate, PermissionRequestHookDecision } from "./types.ts";
import type { PermissionDecision } from "./policy.ts";
import type { RelayResult } from "./relay-lifecycle.ts";
export interface PolicySettingsSnapshot { permissions: PermissionRuleSettings; sources: string[]; errors: string[]; warnings: string[]; localSettingsPath: string; }
export interface PermissionSessionPorts<Host> {
  cwd(host: Host): string;
  signal(host: Host): AbortSignal | undefined;
  hasUI(host: Host): boolean;
  captureCurrent(host: Host): () => void;
  load(host: Host): Promise<PolicySettingsSnapshot>;
  saveMode(path: string, mode: PermissionMode): Promise<void>;
  addRule(path: string, behavior: PermissionBehavior, rule: string): Promise<void>;
  updateRules(path: string, behavior: PermissionBehavior, operation: "add"|"replace"|"remove", rules: string[]): Promise<void>;
  setMode?(mode: PermissionMode, host: Host): void | Promise<void>;
  notify(host: Host, text: string, level: "warning"|"info"): void;
  select(host: Host, prompt: string, choices: string[]): Promise<string | undefined>;
  attention?(event: {id:string;kind:"permission";subject:string}, host: Host): void;
  isChild(): boolean;
  relay<T>(interaction: "permission"|"question", payload: Record<string, unknown>, timeout: undefined, signal?: AbortSignal): Promise<RelayResult<T>>;
  evaluate(call: PermissionToolCall, mode: PermissionMode, settings: PermissionRuleSettings, cwd: string): PermissionDecision;
  suggest(call: PermissionToolCall, cwd: string): string;
}
export interface PermissionRequestHookRunner<Host> {
  requestPermission(
    call: PermissionToolCall,
    ctx: Host,
    suggestion: string,
    forced: boolean,
  ): Promise<PermissionRequestHookDecision | undefined>;
}

export interface PermissionOverview {
  mode: string;
  allow: readonly string[];
  ask: readonly string[];
  deny: readonly string[];
  sources: string;
}

export interface PermissionSession<Host> {
  reload(ctx: Host): Promise<PermissionMode | undefined>;
  setDefaultMode(ctx: Host, mode: PermissionMode): Promise<void>;
  authorize(
    call: PermissionToolCall,
    ctx: Host,
    mode: PermissionMode,
    hooks?: PermissionRequestHookRunner<Host>,
  ): Promise<{ block: true; reason: string } | undefined>;
  summary(mode: PermissionMode): string;
  overview(mode: PermissionMode): PermissionOverview;
  bypassDisabled(): boolean;
}

export function createPermissionSession<Host>(ports: PermissionSessionPorts<Host>): PermissionSession<Host> {
  const fence = createOperationFence(ports);
  const operation = (ctx: Host) => {
    const check = fence.capture(ctx);
    return async <T>(work: Promise<T>): Promise<T> => { const value = await work; check(); return value; };
  };
  let loaded: PolicySettingsSnapshot | undefined;
  let nextPromptId = 0;
  const sessionRules: Record<PermissionBehavior, string[]> = { allow: [], ask: [], deny: [] };

  return {
    async reload(ctx) {
      fence.invalidate(); const checked = operation(ctx);
      sessionRules.allow = [];
      sessionRules.ask = [];
      sessionRules.deny = [];
      loaded = await checked(ports.load(ctx));
      for (const error of loaded.errors) ports.notify(ctx, `权限配置无效：${error}`, "warning");
      for (const warning of loaded.warnings) ports.notify(ctx, `权限配置提示：${warning}`, "warning");
      const defaultMode = loaded.permissions.defaultMode;
      if (defaultMode === "bypassPermissions" && this.bypassDisabled()) return "default";
      return defaultMode;
    },

    async setDefaultMode(ctx, mode) {
      const checked = operation(ctx);
      if (!loaded) loaded = await checked(ports.load(ctx));
      if (mode === "bypassPermissions" && loaded.permissions.disableBypassPermissionsMode === "disable") {
        throw new Error("YOLO mode is disabled by permissions.disableBypassPermissionsMode.");
      }
      await checked(ports.saveMode(loaded.localSettingsPath, mode));
      loaded.permissions.defaultMode = mode;
      await checked(Promise.resolve(ports.setMode?.(mode, ctx)));
    },

    async authorize(call, ctx, mode, hooks) {
      const checked = operation(ctx);
      // RPC reports dialog capability as hasUI=true, even though a teammate
      // child has no local terminal. The parent owns the live mode, session
      // rules, hooks, persistence, and any user prompt.
      if (ports.isChild()) {
        const relay = await checked(ports.relay<{
          action: "allow_once" | "deny";
          reason?: string;
          updatedInput?: Record<string, unknown>;
        }>("permission", {
          authorization: "parent",
          toolName: call.toolName,
          input: call.input,
        }, undefined, ports.signal(ctx)));
        if (!relay.ok) {
          const detail = relay.error ? `: ${relay.error}` : "";
          return {
            block: true,
            reason: `Permission relay ${relay.reason}${detail}.`,
          };
        }
        const relayed = relay.result;
        if (relayed.updatedInput) replaceRecord(call.input, relayed.updatedInput);
        if (relayed.action === "allow_once") return;
        return {
          block: true,
          reason: relayed.reason ?? "Permission was denied by the parent session.",
        };
      }

      const settings = effectiveSettings(loaded?.permissions, sessionRules);
      if (loaded?.errors.length && mode !== "bypassPermissions") {
        const toolDecision = ports.evaluate(call, "dontAsk", settings, ports.cwd(ctx));
        if (toolDecision.behavior !== "allow") {
          return { block: true, reason: "Permission settings are invalid; non-read-only tools are blocked until the configuration is fixed." };
        }
      }
      const decision = ports.evaluate(call, mode, settings, ports.cwd(ctx));
      if (decision.behavior === "allow") return;
      if (decision.behavior === "deny") return { block: true, reason: decision.reason };

      const suggestion = ports.suggest(call, ports.cwd(ctx));
      const hookDecision = await checked(Promise.resolve(hooks?.requestPermission(call, ctx, suggestion, Boolean(decision.rule))));
      const inputWasUpdated = Boolean(hookDecision?.updatedInput);
      let updatedMode: PermissionMode | undefined;
      if (hookDecision?.updatedInput) replaceRecord(call.input, hookDecision.updatedInput);
      if (hookDecision?.updatedPermissions) {
        try {
          updatedMode = await applyPermissionUpdates(
            hookDecision.updatedPermissions,
            loaded,
            sessionRules,
            ports.setMode,
            ctx, ports, checked,
          );
        } catch (error) {
          return { block: true, reason: `Permission update failed: ${errorMessage(error)}` };
        }
      }
      if (hookDecision?.behavior === "deny") {
        return { block: true, reason: hookDecision.message ?? "Permission request denied by hook." };
      }
      if (hookDecision?.behavior === "allow") {
        if (updatedMode === "plan") {
          return { block: true, reason: "Permission mode changed to plan; retry the tool so it is re-evaluated under plan mode." };
        }
        if (!inputWasUpdated && !hookDecision.updatedPermissions?.length) return;
        const reevaluated = ports.evaluate(
          call,
          updatedMode ?? mode,
          effectiveSettings(loaded?.permissions, sessionRules),
          ports.cwd(ctx),
        );
        if (reevaluated.behavior === "deny") return { block: true, reason: reevaluated.reason };
        if (reevaluated.behavior === "allow") return;
      }
      if (!ports.hasUI(ctx)) {
        return { block: true, reason: `Permission required for ${suggestion}, but no interactive UI is available.` };
      }

      ports.attention?.({
        id: `permission:${++nextPromptId}`,
        kind: "permission",
        subject: call.toolName,
      }, ctx);
      const choice = await checked(ports.select(ctx, permissionPrompt(call, decision.reason), [
        "Allow once",
        "Always allow",
        "Deny",
      ]));
      if (choice === "Allow once") return;
      if (choice === "Always allow") {
        if (!loaded) loaded = await checked(ports.load(ctx));
        try {
          await checked(ports.addRule(loaded.localSettingsPath, "allow", suggestion));
        } catch (error) {
          return { block: true, reason: `Failed to persist permission rule: ${errorMessage(error)}` };
        }
        loaded.permissions.allow = [...new Set([...loaded.permissions.allow, suggestion])];
        ports.notify(ctx, `已写入本地权限规则：${suggestion}`, "info");
        return;
      }
      return { block: true, reason: `Permission denied by user for ${suggestion}.` };
    },

    summary(mode) {
      const permissions = loaded?.permissions ?? { allow: [], ask: [], deny: [] };
      const sources = loaded?.sources.length ? loaded.sources.join("\n") : "无配置文件";
      return [
        `Mode: ${mode}`,
        formatRules("Allow", [...permissions.allow, ...sessionRules.allow]),
        formatRules("Ask", [...permissions.ask, ...sessionRules.ask]),
        formatRules("Deny", [...permissions.deny, ...sessionRules.deny]),
        "",
        `Sources:\n${sources}`,
      ].join("\n");
    },

    overview(mode) {
      const permissions = loaded?.permissions ?? { allow: [], ask: [], deny: [] };
      return {
        mode,
        allow: [...new Set([...permissions.allow, ...sessionRules.allow])],
        ask: [...new Set([...permissions.ask, ...sessionRules.ask])],
        deny: [...new Set([...permissions.deny, ...sessionRules.deny])],
        sources: loaded?.sources.length ? loaded.sources.join(", ") : "无配置文件",
      };
    },

    bypassDisabled() {
      return loaded?.permissions.disableBypassPermissionsMode === "disable";
    },
  };
}

function effectiveSettings(
  loaded: PermissionRuleSettings | undefined,
  session: Record<PermissionBehavior, string[]>,
): PermissionRuleSettings {
  return {
    allow: [...new Set([...(loaded?.allow ?? []), ...session.allow])],
    ask: [...new Set([...(loaded?.ask ?? []), ...session.ask])],
    deny: [...new Set([...(loaded?.deny ?? []), ...session.deny])],
    ...(loaded?.defaultMode ? { defaultMode: loaded.defaultMode } : {}),
    ...(loaded?.disableBypassPermissionsMode ? {
      disableBypassPermissionsMode: loaded.disableBypassPermissionsMode,
    } : {}),
  };
}

async function applyPermissionUpdates<Host>(
  updates: PermissionUpdate[],
  loaded: PolicySettingsSnapshot | undefined,
  session: Record<PermissionBehavior, string[]>,
  setMode: ((mode: PermissionMode, ctx: Host) => void | Promise<void>) | undefined,
  ctx: Host,
  ports: PermissionSessionPorts<Host>,
  checked: <T>(work: Promise<T>) => Promise<T>,
): Promise<PermissionMode | undefined> {
  let updatedMode: PermissionMode | undefined;
  for (const update of updates) {
    if (update.type === "setMode" && update.mode) {
      if (update.mode === "bypassPermissions" && loaded?.permissions.disableBypassPermissionsMode === "disable") {
        continue;
      }
      if (update.destination === "localSettings" && loaded) {
        await checked(ports.saveMode(loaded.localSettingsPath, update.mode));
        loaded.permissions.defaultMode = update.mode;
      }
      await checked(Promise.resolve(setMode?.(update.mode, ctx)));
      updatedMode = update.mode;
      continue;
    }
    if (!update.behavior || !["addRules", "replaceRules", "removeRules"].includes(update.type)) continue;
    const rules = (update.rules ?? []).map((rule) =>
      rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName
    );
    const operation = update.type === "addRules" ? "add"
      : update.type === "replaceRules" ? "replace"
        : "remove";
    if (update.destination === "localSettings" && loaded) {
      await checked(ports.updateRules(loaded.localSettingsPath, update.behavior, operation, rules));
      if (operation === "replace") loaded.permissions[update.behavior] = [...new Set(rules)];
      if (operation === "add") {
        loaded.permissions[update.behavior] = [...new Set([...loaded.permissions[update.behavior], ...rules])];
      }
      if (operation === "remove") {
        const removals = new Set(rules);
        loaded.permissions[update.behavior] = loaded.permissions[update.behavior]
          .filter((rule) => !removals.has(rule));
      }
    } else {
      if (operation === "replace") session[update.behavior] = [...new Set(rules)];
      if (operation === "add") session[update.behavior] = [...new Set([...session[update.behavior], ...rules])];
      if (operation === "remove") {
        const removals = new Set(rules);
        session[update.behavior] = session[update.behavior].filter((rule) => !removals.has(rule));
      }
    }
  }
  return updatedMode;
}

function permissionPrompt(call: PermissionToolCall, reason: string): string {
  const details = typeof call.input.command === "string"
    ? call.input.command
    : typeof call.input.path === "string"
      ? call.input.path
      : typeof call.input.file_path === "string"
        ? call.input.file_path
        : JSON.stringify(call.input);
  const bounded = details.length > 500 ? `${details.slice(0, 497)}...` : details;
  return `Permission required: ${call.toolName}\n\n${bounded}\n\n${reason}`;
}

function replaceRecord(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function formatRules(label: string, rules: string[]): string {
  const unique = [...new Set(rules)];
  return `${label} (${unique.length}): ${unique.length ? unique.join(", ") : "-"}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
