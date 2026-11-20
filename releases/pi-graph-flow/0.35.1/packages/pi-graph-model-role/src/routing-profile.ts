import { TEAMMATE_TASK_TYPES, parseTeammateTaskType, type TeammateTaskType } from './task-types.ts';
import type { TeammateThinkingLevel } from './thinking.ts';
import type { ModelRoutingRules, ModelRoutingRoleRules, ModelRoutingTypeMeta } from './routing-types.ts';
import { emptyRules, cloneRules, mergeRules, assertRoleName, normalizeRoleRulesInput, normalizeTypeMetaInput } from './routing-policy.ts';
import { TEAMMATE_SMART_MODES, type TeammateSmartMode, type ModelRoutingValidationBounds, type ModelRoutingProfile, type GlobalModelRoutingStore, type ProjectModelRoutingStore, type ModelRoutingProfileSummary } from './routing-types.ts';
import { hasOwn, assertKnownKeys, validateV3Rules, normalizeRules, hasRules } from './routing-policy.ts';
const DEFAULT_PROFILE_ID = 'default';
const DEFAULT_PROFILE_NAME = 'Default';
export function normalizeProfileName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?|\n|\t/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim();
  return normalized ? normalized.slice(0, 64) : fallback;
}

/** Return whether a value is a canonical 1..48 character V3 routing profile ID. */
export function isModelRoutingProfileId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,47}$/.test(value);
}

export function profileIdFromName(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return base || "profile";
}

export function nextProfileId(store: GlobalModelRoutingStore, name: string): string {
  const base = profileIdFromName(name);
  const unavailable = (candidate: string): boolean =>
    hasOwn(store.profiles, candidate) || (store.retiredProfileIds?.includes(candidate) ?? false);
  if (!unavailable(base)) return base;
  for (let index = 2; index < 10_000; index++) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!unavailable(candidate)) return candidate;
  }
  throw new Error("Unable to allocate a teammate model profile ID");
}

export function invalidGlobalStore(): never {
  throw new Error("Invalid v3 global teammate model config");
}

export function normalizeGlobalStore(parsed: Record<string, unknown> | undefined, bounds: ModelRoutingValidationBounds): GlobalModelRoutingStore {
  if ((parsed?.version === 3 || parsed?.version === 4)) {
    assertKnownKeys(parsed, ["version", "defaultProfile", "profiles", "retiredProfileIds", "smartMode", "askBeforeDispatch", "backgroundStatusHeartbeatMs"], "v3 global config");
    if (!parsed.profiles || typeof parsed.profiles !== "object" || Array.isArray(parsed.profiles)) {
      return invalidGlobalStore();
    }
    const profiles: Record<string, ModelRoutingProfile> = {};
    for (const [profileId, rawProfile] of Object.entries(parsed.profiles as Record<string, unknown>)) {
      if (!isModelRoutingProfileId(profileId) || !rawProfile || typeof rawProfile !== "object" || Array.isArray(rawProfile)) {
        return invalidGlobalStore();
      }
      const profile = rawProfile as Record<string, unknown>;
      assertKnownKeys(profile, ["name", "mappings", "fallbackMappings", "thinkingLevels", "roleMappings", "typeMeta", ...(parsed.version === 4 ? ["fastModes"] : [])], `Profile ${profileId}`);
      if (typeof profile.name !== "string" || !normalizeProfileName(profile.name, "")) return invalidGlobalStore();
      validateV3Rules({
        mappings: profile.mappings,
        ...(hasOwn(profile, "fallbackMappings") ? { fallbackMappings: profile.fallbackMappings } : {}),
        thinkingLevels: profile.thinkingLevels,
        ...(hasOwn(profile, "fastModes") ? { fastModes: profile.fastModes } : {}),
        ...(hasOwn(profile, "roleMappings") ? { roleMappings: profile.roleMappings } : {}),
        ...(hasOwn(profile, "typeMeta") ? { typeMeta: profile.typeMeta } : {}),
      }, `Profile ${profileId}`, parsed.version === 4);
      profiles[profileId] = {
        name: normalizeProfileName(profile.name, profileId),
        ...normalizeRules(profile),
      };
    }
    if (Object.keys(profiles).length === 0) return invalidGlobalStore();
    const requestedDefault = typeof parsed.defaultProfile === "string" ? parsed.defaultProfile.trim() : "";
    if (!hasOwn(profiles, requestedDefault)) return invalidGlobalStore();
    const retiredProfileIds = parsed.retiredProfileIds === undefined
      ? []
      : Array.isArray(parsed.retiredProfileIds)
        && new Set(parsed.retiredProfileIds).size === parsed.retiredProfileIds.length
        && parsed.retiredProfileIds.every((entry) =>
          isModelRoutingProfileId(entry) && !hasOwn(profiles, entry)
        )
        ? [...new Set(parsed.retiredProfileIds as string[])]
        : invalidGlobalStore();
    const smartMode: TeammateSmartMode = parsed.smartMode === true
      ? "balanced"
      : parsed.smartMode === false || parsed.smartMode === undefined
        ? "off"
        : typeof parsed.smartMode === "string"
          && (TEAMMATE_SMART_MODES as readonly string[]).includes(parsed.smartMode)
          ? parsed.smartMode as TeammateSmartMode
          : invalidGlobalStore();
    if (parsed.askBeforeDispatch !== undefined && typeof parsed.askBeforeDispatch !== "boolean") {
      return invalidGlobalStore();
    }
    const backgroundStatusHeartbeatMs = parsed.backgroundStatusHeartbeatMs;
    if (backgroundStatusHeartbeatMs !== undefined
      && (typeof backgroundStatusHeartbeatMs !== "number"
        || !Number.isSafeInteger(backgroundStatusHeartbeatMs)
        || backgroundStatusHeartbeatMs < bounds.heartbeatMinMs
        || backgroundStatusHeartbeatMs > bounds.heartbeatMaxMs)) {
      return invalidGlobalStore();
    }
    return {
      version: 4,
      defaultProfile: requestedDefault,
      profiles,
      ...(retiredProfileIds.length > 0 ? { retiredProfileIds } : {}),
      ...(smartMode === "off" ? {} : { smartMode }),
      ...(parsed.askBeforeDispatch === true ? { askBeforeDispatch: true } : {}),
      ...(backgroundStatusHeartbeatMs === undefined ? {} : { backgroundStatusHeartbeatMs }),
    };
  }
  if (parsed?.version !== undefined && parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported teammate model config version: ${String(parsed.version)}`);
  }
  const legacyRules = normalizeRules(parsed);
  return {
    version: 4,
    defaultProfile: DEFAULT_PROFILE_ID,
    profiles: {
      [DEFAULT_PROFILE_ID]: { name: DEFAULT_PROFILE_NAME, ...legacyRules },
    },
  };
}

export function normalizeProjectStore(parsed: Record<string, unknown> | undefined): ProjectModelRoutingStore {
  if ((parsed?.version === 3 || parsed?.version === 4)) {
    assertKnownKeys(parsed, ["version", "activeProfile", "applyOverrides", "overrides"], "v3 project config");
    if (typeof parsed.applyOverrides !== "boolean"
      || !parsed.overrides
      || typeof parsed.overrides !== "object"
      || Array.isArray(parsed.overrides)) {
      throw new Error("Invalid v3 project teammate model config");
    }
    if (parsed.activeProfile !== undefined
      && (typeof parsed.activeProfile !== "string" || !isModelRoutingProfileId(parsed.activeProfile.trim()))) {
      throw new Error("Invalid active Profile in project teammate model config");
    }
    const activeProfile = typeof parsed.activeProfile === "string" && parsed.activeProfile.trim()
      ? parsed.activeProfile.trim()
      : undefined;
    const overridesRecord = parsed.overrides as Record<string, unknown>;
    validateV3Rules(overridesRecord, "project overrides", parsed.version === 4);
    const overrides = normalizeRules(overridesRecord);
    return {
      version: 4,
      ...(activeProfile ? { activeProfile } : {}),
      applyOverrides: parsed.applyOverrides,
      overrides,
    };
  }
  if (parsed?.version !== undefined && parsed.version !== 1 && parsed.version !== 2) {
    throw new Error(`Unsupported project teammate model config version: ${String(parsed.version)}`);
  }
  const overrides = normalizeRules(parsed);
  return {
    version: 4,
    applyOverrides: hasRules(overrides),
    overrides,
  };
}

export function requireProfile(store: GlobalModelRoutingStore, profileId: string): ModelRoutingProfile {
  if (!hasOwn(store.profiles, profileId)) throw new Error(`Unknown teammate model profile: ${profileId}`);
  return store.profiles[profileId];
}

export function sortedProfileSummaries(
  store: GlobalModelRoutingStore,
  activeProfileId?: string,
): ModelRoutingProfileSummary[] {
  return Object.entries(store.profiles)
    .map(([id, profile]) => ({
      id,
      name: profile.name,
      active: id === activeProfileId,
      default: id === store.defaultProfile,
    }))
    .sort((left, right) =>
      Number(right.active) - Number(left.active)
      || left.name.localeCompare(right.name)
      || left.id.localeCompare(right.id)
    );
}

export function resolveProfileId(store: GlobalModelRoutingStore, reference: string): string {
  const query = reference.trim();
  if (!query) throw new Error("Teammate model profile or template name is required");
  if (hasOwn(store.profiles, query)) return query;

  const entries = Object.entries(store.profiles);
  const lowerQuery = query.toLowerCase();
  const caseInsensitiveIds = entries.filter(([id]) => id.toLowerCase() === lowerQuery);
  if (caseInsensitiveIds.length === 1) return caseInsensitiveIds[0]![0];

  const exactNames = entries.filter(([, profile]) => profile.name === query);
  if (exactNames.length === 1) return exactNames[0]![0];
  if (exactNames.length > 1) {
    throw new Error(`Ambiguous teammate model template "${query}"; use one of these IDs: ${exactNames.map(([id]) => id).join(", ")}`);
  }

  const names = entries.filter(([, profile]) => profile.name.toLowerCase() === lowerQuery);
  if (names.length === 1) return names[0]![0];
  if (names.length > 1) {
    throw new Error(`Ambiguous teammate model template "${query}"; use one of these IDs: ${names.map(([id]) => id).join(", ")}`);
  }
  throw new Error(`Unknown teammate model profile or template: ${query}`);
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function modelMappingUpdate(taskType: TeammateTaskType, model: string | null): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return (profile) => {
    profile.mappings[normalizedTaskType] = model;
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function thinkingLevelUpdate(taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return (profile) => {
    profile.thinkingLevels[normalizedTaskType] = thinking;
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function fastModeUpdate(taskType: TeammateTaskType, fast: boolean | null): (profile: ModelRoutingRules) => void {
  const normalized = parseTeammateTaskType(taskType);
  if (!normalized) throw new Error(`Invalid teammate task type: ${taskType}`);
  if (fast !== null && typeof fast !== "boolean") throw new Error("Fast must be boolean or null");
  return (profile) => {
    profile.fastModes ??= {};
    profile.fastModes[normalized] = fast;
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function fallbackMappingUpdate(taskType: TeammateTaskType, models: string[] | null): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return (profile) => {
    profile.fallbackMappings ??= {};
    profile.fallbackMappings[normalizedTaskType] = models === null
      ? null
      : [...new Set(models.map((model) => model.trim()).filter(Boolean))];
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function roleMappingUpdate(role: string, rules: ModelRoutingRoleRules | null): (profile: ModelRoutingRules) => void {
  assertRoleName(role);
  const normalized = normalizeRoleRulesInput(rules);
  return (profile) => {
    profile.roleMappings ??= {};
    profile.roleMappings[role] = normalized;
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function typeRolesUpdate(taskType: TeammateTaskType, roles: readonly string[]): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  const requestedRoles = new Set(roles.map((role) => {
    assertRoleName(role);
    return role;
  }));
  return (profile) => {
    profile.roleMappings ??= {};
    for (const [role, existing] of Object.entries(profile.roleMappings)) {
      if (existing?.taskType !== normalizedTaskType || requestedRoles.has(role)) continue;
      profile.roleMappings[role] = { ...existing, taskType: null };
    }
    for (const role of requestedRoles) {
      const existing = profile.roleMappings[role];
      profile.roleMappings[role] = { ...(existing ?? {}), taskType: normalizedTaskType };
    }
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function typeMetaUpdate(taskType: TeammateTaskType, meta: ModelRoutingTypeMeta | null): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  return (profile) => {
    profile.typeMeta ??= {};
    const patch = normalizeTypeMetaInput(meta);
    if (meta === null || patch.keywords === undefined) {
      delete profile.typeMeta[normalizedTaskType];
      return;
    }
    profile.typeMeta[normalizedTaskType] = patch;
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function customTypeUpdate(taskType: TeammateTaskType, meta: ModelRoutingTypeMeta | null = null): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(normalizedTaskType)) {
    throw new Error(`Cannot register a built-in teammate task type: ${normalizedTaskType}`);
  }
  const normalizedMeta = normalizeTypeMetaInput(meta);
  return (profile) => {
    profile.mappings[normalizedTaskType] = null;
    if (normalizedMeta.keywords !== undefined) {
      profile.typeMeta ??= {};
      profile.typeMeta[normalizedTaskType] = normalizedMeta;
    }
  };
}

/** Prepare the original validated in-memory update before the host takes its lock. */
export function deleteCustomTypeUpdate(taskType: TeammateTaskType): (profile: ModelRoutingRules) => void {
  const normalizedTaskType = parseTeammateTaskType(taskType);
  if (!normalizedTaskType) throw new Error(`Invalid teammate task type: ${taskType}`);
  if ((TEAMMATE_TASK_TYPES as readonly string[]).includes(normalizedTaskType)) {
    throw new Error(`Cannot delete a built-in teammate task type: ${normalizedTaskType}`);
  }
  return (profile) => {
    delete profile.mappings[normalizedTaskType];
    if (profile.fallbackMappings) delete profile.fallbackMappings[normalizedTaskType];
    if (profile.thinkingLevels) delete profile.thinkingLevels[normalizedTaskType];
    if (profile.fastModes) delete profile.fastModes[normalizedTaskType];
    if (profile.typeMeta) delete profile.typeMeta[normalizedTaskType];
    if (profile.roleMappings) {
      for (const [role, rules] of Object.entries(profile.roleMappings)) {
        if (rules?.taskType === normalizedTaskType) profile.roleMappings[role] = { ...rules, taskType: null };
      }
    }
  };
}

export function requireRoutingProfileName(name: string): string {
  const normalized = normalizeProfileName(name, '');
  if (!normalized) throw new Error('Profile name is required');
  return normalized;
}
export function profileNameUpdate(name: string): (profile: ModelRoutingProfile) => void {
  const normalizedName = requireRoutingProfileName(name);
  return profile => { profile.name = normalizedName; };
}
/** The caller owns this freshly read store and publishes through its original transaction. */
export function addRoutingProfile(store: GlobalModelRoutingStore, name: string, sourceProfileId?: string): string {
  const normalizedName = requireRoutingProfileName(name);
  const profileId = nextProfileId(store, normalizedName);
  const source = sourceProfileId ? requireProfile(store, sourceProfileId) : undefined;
  store.profiles[profileId] = { name: normalizedName, ...(source ? cloneRules(source) : emptyRules()) };
  return profileId;
}
export function setRoutingDefaultProfile(store: GlobalModelRoutingStore, profileId: string): void {
  requireProfile(store, profileId); store.defaultProfile = profileId;
}
export function activateRoutingProjectProfile(global: GlobalModelRoutingStore, project: ProjectModelRoutingStore, profileId: string): void {
  requireProfile(global, profileId); project.activeProfile = profileId; project.applyOverrides = false;
}
export function setRoutingProjectOverridesEnabled(project: ProjectModelRoutingStore, enabled: boolean): void {
  project.applyOverrides = enabled && hasRules(project.overrides);
}
export function clearRoutingProjectOverrides(project: ProjectModelRoutingStore): void {
  project.applyOverrides = false; project.overrides = emptyRules();
}
export function promoteRoutingProjectOverrides(global: GlobalModelRoutingStore, project: ProjectModelRoutingStore, name: string): string {
  const normalizedName = requireRoutingProfileName(name);
  if (!hasRules(project.overrides)) throw new Error('This project has no teammate model routing overrides');
  const requestedProfile = project.activeProfile ?? global.defaultProfile;
  const selectedProfileId = hasOwn(global.profiles, requestedProfile) ? requestedProfile : global.defaultProfile;
  const profileId = nextProfileId(global, normalizedName);
  global.profiles[profileId] = { name: normalizedName, ...mergeRules(global.profiles[selectedProfileId], project.overrides) };
  project.activeProfile = profileId; project.applyOverrides = false;
  return profileId;
}
export function assertDeletableRoutingProfile(global: GlobalModelRoutingStore, profileId: string): void {
  requireProfile(global, profileId);
  if (global.defaultProfile === profileId) throw new Error('The default teammate model profile cannot be deleted');
}
export function deleteRoutingProfile(global: GlobalModelRoutingStore, project: ProjectModelRoutingStore, profileId: string): boolean {
  assertDeletableRoutingProfile(global, profileId);
  const projectChanged = project.activeProfile === profileId;
  delete global.profiles[profileId];
  global.retiredProfileIds = [...new Set([...(global.retiredProfileIds ?? []), profileId])];
  if (projectChanged) { project.activeProfile = global.defaultProfile; project.applyOverrides = false; }
  return projectChanged;
}
