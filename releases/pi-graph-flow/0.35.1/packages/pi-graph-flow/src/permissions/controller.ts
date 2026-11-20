/** SDK/IO adapter for the sole permission-session owner. */
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPermissionSession, type PermissionSession, type PermissionRequestHookRunner as CoreHookRunner, type PermissionOverview } from "pi-graph-permission-core";
import { evaluatePermission, suggestedAllowRule } from "./policy.ts";
import { isTeammateChild, requestTeammateInteraction } from "./teammate-relay.ts";
import type { UserAttentionHandler } from "../notify/user-attention.ts";
import { addPermissionRule, loadPermissionSettings, setPermissionDefaultMode, updatePermissionRules } from "./settings.ts";
import type { PermissionMode } from "./types.ts";
export type { PermissionOverview };
export interface PermissionRequestHookRunner extends CoreHookRunner<ExtensionContext> {}
export interface PermissionController extends PermissionSession<ExtensionContext> {}
export function createPermissionController(options: {
  userSettingsPath?: string;
  setMode?: (mode: PermissionMode, ctx: ExtensionContext) => void | Promise<void>;
  onUserAttention?: UserAttentionHandler;
} = {}): PermissionController {
  const path = options.userSettingsPath ?? join(getAgentDir(), "settings.json");
  return createPermissionSession<ExtensionContext>({
    cwd: ctx => ctx.cwd, signal: ctx => ctx.signal, hasUI: ctx => ctx.hasUI,
    captureCurrent(ctx) {
      const manager = ctx.sessionManager, sessionId = manager.getSessionId(), cwd = ctx.cwd;
      return () => {
        if (ctx.sessionManager !== manager || manager.getSessionId() !== sessionId || ctx.cwd !== cwd || ctx.signal?.aborted)
          throw new Error("Permission source changed");
      };
    },
    load: ctx => loadPermissionSettings(ctx.cwd, path), saveMode: setPermissionDefaultMode,
    addRule: addPermissionRule, updateRules: updatePermissionRules, setMode: options.setMode,
    notify: (ctx, text, level) => ctx.ui.notify(text, level),
    select: (ctx, prompt, choices) => ctx.ui.select(prompt, choices, { signal: ctx.signal }),
    attention: options.onUserAttention, isChild: isTeammateChild, relay: requestTeammateInteraction,
    evaluate: evaluatePermission, suggest: suggestedAllowRule,
  });
}
