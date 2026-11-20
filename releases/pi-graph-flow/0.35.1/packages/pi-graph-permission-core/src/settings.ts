import { PERMISSION_MODES, type PermissionMode, type PermissionRuleSettings } from "./types.ts";
export function validatePermissions(raw: Record<string, unknown>): Partial<PermissionRuleSettings> {
  const result: Partial<PermissionRuleSettings> = {};
  for (const behavior of ["allow", "ask", "deny"] as const) {
    if (raw[behavior] === undefined) continue;
    if (!Array.isArray(raw[behavior]) || raw[behavior].some((entry) => typeof entry !== "string")) {
      throw new Error(`permissions.${behavior} must be an array of strings`);
    }
    result[behavior] = raw[behavior] as string[];
  }
  if (raw.defaultMode !== undefined) {
    if (typeof raw.defaultMode !== "string" || !PERMISSION_MODES.includes(raw.defaultMode as PermissionMode)) {
      throw new Error(`permissions.defaultMode must be one of ${PERMISSION_MODES.join(", ")}`);
    }
    result.defaultMode = raw.defaultMode as PermissionMode;
  }
  if (raw.disableBypassPermissionsMode !== undefined) {
    if (raw.disableBypassPermissionsMode !== "disable") {
      throw new Error('permissions.disableBypassPermissionsMode must be "disable"');
    }
    result.disableBypassPermissionsMode = "disable";
  }
  return result;
}

export function mergePermissions(target: PermissionRuleSettings, source: Partial<PermissionRuleSettings> | undefined): void {
  if (!source) return;
  for (const behavior of ["allow", "ask", "deny"] as const) {
    target[behavior] = [...new Set([...target[behavior], ...(source[behavior] ?? [])])];
  }
  if (source.defaultMode) target.defaultMode = source.defaultMode;
  if (source.disableBypassPermissionsMode) {
    target.disableBypassPermissionsMode = source.disableBypassPermissionsMode;
  }
}

export function restrictUntrustedProjectPermissions(
  source: Partial<PermissionRuleSettings> | undefined,
  filePath: string,
  warnings: string[],
): Partial<PermissionRuleSettings> | undefined {
  if (!source) return source;
  const restricted: Partial<PermissionRuleSettings> = {
    ask: source.ask ?? [],
    deny: source.deny ?? [],
    ...(source.disableBypassPermissionsMode ? {
      disableBypassPermissionsMode: source.disableBypassPermissionsMode,
    } : {}),
  };
  if (source.allow?.length) {
    warnings.push(`${filePath}: project allow rules were ignored; approve them into local settings first`);
  }
  if (source.defaultMode === "default" || source.defaultMode === "plan" || source.defaultMode === "dontAsk") {
    restricted.defaultMode = source.defaultMode;
  } else if (source.defaultMode) {
    warnings.push(`${filePath}: project defaultMode ${source.defaultMode} was ignored because it weakens permissions`);
  }
  return restricted;
}

