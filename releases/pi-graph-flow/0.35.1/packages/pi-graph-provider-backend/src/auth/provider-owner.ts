/** Provider connection lifecycle. Writers, secrets, UI and SDK registration stay on the bound Host. */
import { authError } from "./contracts.ts";
export interface ProviderAuthContext {
  cwd: string; hasUI: boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void; confirm(title: string, message: string): Promise<boolean>; select(title: string, values: string[]): Promise<string | undefined>; };
  modelRegistry: { refresh(): void; };
}
export interface ProviderAuthWriteResult { path: string; backupPath?: string; }
export interface ProviderAuthPorts<P, C extends ProviderAuthContext, R extends ProviderAuthWriteResult, L extends string> {
  defaultThinkingLevel: L;
  isProviderConfigured(id: string, path: string): Promise<boolean>; isProviderEnabled(id: string, path: string): Promise<boolean>;
  configuredModelIds(id: string, path: string): Promise<string[]>;
  deleteApiProviderSettings(id: string, path: string): Promise<R>; deleteApiProviderModelSettings(id: string, model: string, path: string): Promise<R>;
  setApiProviderEnabled(id: string, enabled: boolean, path: string): Promise<R>;
  deleteProviderThinkingDefaults(id: string, models: readonly string[], settings: string, cwd: string, defaults: string): Promise<void>;
  deleteModelThinkingDefault(id: string, model: string, settings: string, cwd: string, defaults: string): Promise<void>;
  clearDeletedDefaultModel(settings: string, id: string, model: string): Promise<void>;
  removeManagedProvider(defaults: string, id: string): Promise<void>;
  saveDefaultThinkingLevel(ctx: C, path: string, level: L): Promise<void>;
  registerProvider(pi: P, id: string, path: string): void; suspendProviderRegistration(pi: P, id: string): void; unregisterProvider(pi: P, id: string): void;
  reloadProviderRegistration(pi: P, ctx: C, id: string, path: string): void;
  notifySaved(ctx: C, displayName: string, result: R, message: string): void;
}
export function createProviderAuthOwner<P, C extends ProviderAuthContext, R extends ProviderAuthWriteResult, L extends string>(host: ProviderAuthPorts<P,C,R,L>) {
  const { defaultThinkingLevel, isProviderConfigured, isProviderEnabled, configuredModelIds, deleteApiProviderSettings,
    deleteApiProviderModelSettings, setApiProviderEnabled, deleteProviderThinkingDefaults, deleteModelThinkingDefault,
    clearDeletedDefaultModel, removeManagedProvider, saveDefaultThinkingLevel, registerProvider, suspendProviderRegistration,
    unregisterProvider, reloadProviderRegistration, notifySaved } = host;
async function removeProviderKey(
  pi: P,
  providerId: string,
  displayName: string,
  ctx: C,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需注销。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `注销 ${displayName}？`,
    "将删除该 Provider 的 Base URL、models 和 API key；重新新增必须显式输入独立 URL 和 API key。",
  );
  if (!confirmed) return;
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, modelIds, settingsPath, ctx.cwd, defaultsPath);
  for (const modelId of modelIds) {
    await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  }
  await removeManagedProvider(defaultsPath, providerId);
  unregisterProvider(pi, providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, "已注销；连接配置和 API key 已移除");
}

async function toggleProvider(
  pi: P,
  providerId: string,
  displayName: string,
  enabled: boolean,
  ctx: C,
  modelsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置。`, "warning");
    return;
  }
  const current = await isProviderEnabled(providerId, modelsPath);
  if (current === enabled) {
    ctx.ui.notify(`${displayName} 已经${enabled ? "启用" : "停用"}。`, "info");
    return;
  }
  if (ctx.hasUI) {
    const confirmed = await ctx.ui.confirm(
      `${enabled ? "启用" : "停用"} ${displayName}？`,
      enabled
        ? "将重新注册该 Provider，其 models 会恢复到 /model。"
        : "将从运行时移除该 Provider 的 models，但保留 URL、API key 和全部模型配置。",
    );
    if (!confirmed) return;
  }
  const result = await setApiProviderEnabled(providerId, enabled, modelsPath);
  if (enabled) registerProvider(pi, providerId, modelsPath);
  else suspendProviderRegistration(pi, providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, enabled ? "已启用；models 已恢复到 /model" : "已停用；配置仍完整保留");
}

async function resetProvider(
  pi: P,
  providerId: string,
  displayName: string,
  ctx: C,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需重置。`, "info");
    return;
  }
  const confirmed = await ctx.ui.confirm(
    `重置 ${displayName}？`,
    "将清除该 Provider 的连接配置、models、API key 和思考强度默认值；不会写入环境变量占位。",
  );
  if (!confirmed) return;
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const result = await deleteApiProviderSettings(providerId, modelsPath);
  await deleteProviderThinkingDefaults(providerId, modelIds, settingsPath, ctx.cwd, defaultsPath);
  for (const modelId of modelIds) {
    await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  }
  await removeManagedProvider(defaultsPath, providerId);
  await saveDefaultThinkingLevel(ctx, modelsPath, defaultThinkingLevel);
  unregisterProvider(pi, providerId);
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, `已重置为未配置；默认思考强度为 ${defaultThinkingLevel}`);
}

async function deleteProvider(
  pi: P,
  providerId: string,
  displayName: string,
  ctx: C,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  if (!await isProviderConfigured(providerId, modelsPath)) {
    ctx.ui.notify(`${displayName} 尚未配置，无需删除。`, "info");
    return;
  }
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const modelId = modelIds.length === 1
    ? modelIds[0]
    : await ctx.ui.select(`选择要删除的 ${displayName} 模型`, modelIds);
  if (!modelId) return;
  await deleteProviderModel(
    pi,
    providerId,
    displayName,
    modelId,
    ctx,
    modelsPath,
    defaultsPath,
    settingsPath,
  );
}

async function deleteProviderModel(
  pi: P,
  providerId: string,
  displayName: string,
  modelId: string,
  ctx: C,
  modelsPath: string,
  defaultsPath: string,
  settingsPath: string,
): Promise<void> {
  const modelIds = await configuredModelIds(providerId, modelsPath);
  const confirmed = await ctx.ui.confirm(
    `删除 ${displayName}/${modelId}？`,
    "将删除该模型；同一 Provider 的其他模型与连接配置不受影响。",
  );
  if (!confirmed) return;
  const result = await deleteApiProviderModelSettings(providerId, modelId, modelsPath);
  await deleteModelThinkingDefault(providerId, modelId, settingsPath, ctx.cwd, defaultsPath);
  await clearDeletedDefaultModel(settingsPath, providerId, modelId);
  if (modelIds.length === 1) {
    await removeManagedProvider(defaultsPath, providerId);
    unregisterProvider(pi, providerId);
  } else {
    reloadProviderRegistration(pi, ctx, providerId, modelsPath);
  }
  ctx.modelRegistry.refresh();
  notifySaved(ctx, displayName, result, `已删除 ${modelId}；该模型已从 /model 移除`);
}


  const safe = <A extends unknown[]>(method: (...args: A) => Promise<void>) => async (...args: A): Promise<void> => {
    try { await method(...args); } catch (error) { throw authError(error, "provider", "configuration"); }
  };
  async function saveConnection(pi: P, ctx: C, providerId: string, displayName: string, modelsPath: string, write: () => Promise<R>, message: string): Promise<void> {
    try {
      const result = await write();
      reloadProviderRegistration(pi, ctx, providerId, modelsPath);
      notifySaved(ctx, displayName, result, message);
    } catch (error) { throw authError(error, providerId, "configuration"); }
  }
  return { removeProviderKey: safe(removeProviderKey), toggleProvider: safe(toggleProvider), resetProvider: safe(resetProvider),
    deleteProvider: safe(deleteProvider), deleteProviderModel: safe(deleteProviderModel), saveConnection };
}
export interface ProviderRegistrationHost {
  canRegister(): boolean; presetIds: readonly string[];
  configuredIds(): ReadonlySet<string>; managedIds(): readonly string[]; isPreset(id: string): boolean;
  isEnabled(id: string): boolean; allIds(): readonly string[]; register(id: string): void; suspend(id: string): void;
}
/** Original preset/managed/disabled registration order, with disabled malformed entries isolated. */
export function registerProviderConnections(host: ProviderRegistrationHost): void {
  const configured = host.configuredIds();
  if (!host.canRegister()) return;
  for (const id of host.presetIds) if (configured.has(id)) host.register(id);
  for (const id of host.managedIds()) {
    if (host.isPreset(id) || !host.isEnabled(id)) continue;
    host.register(id);
  }
  for (const id of host.allIds()) {
    if (host.isEnabled(id)) continue;
    try { host.suspend(id); } catch { /* Original malformed-disabled startup isolation. */ }
  }
}
