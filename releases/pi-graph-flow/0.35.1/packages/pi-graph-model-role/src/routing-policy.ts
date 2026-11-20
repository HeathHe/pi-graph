import { TEAMMATE_TASK_TYPES, parseTeammateTaskType, type TeammateTaskType } from './task-types.ts';
import { parseTeammateThinkingLevel, type TeammateThinkingLevel } from './thinking.ts';
import type { ModelRoutingRoleRules, ModelRoutingTypeMeta, ModelRoutingRules, ModelRoutingConfig, TaskTypeInput, GlobalModelRoutingStore, ProjectModelRoutingStore, ModelRoutingProfile, ModelRoutingState, ModelRoutingProfileSummary, SessionModelRoutingStore, ModelRoutingRoleDefinition, RoutingCircuitPolicy as ModelCircuitPolicy } from './routing-types.ts';
import type { TeammateModelCapability } from './model-catalog.ts';
import type { DispatchAuthorityProjection } from './model-registry.ts';
import { snapshotHash, type EligibilitySnapshot, type RoleSnapshot, type TaskSelectionDefaults } from './selection.ts';
import { canonicalModelRegistrationId } from './registration-routing.ts';
function canonical(id: string, authority?: DispatchAuthorityProjection): string {
  return authority ? canonicalModelRegistrationId(authority, id) : id;
}
export function emptyRules(): ModelRoutingRules {
  return { mappings: {}, thinkingLevels: {} };
}

export function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function cloneRoleMappings(roleMappings: ModelRoutingRules["roleMappings"]): ModelRoutingRules["roleMappings"] {
  if (!roleMappings) return undefined;
  return Object.fromEntries(Object.entries(roleMappings).map(([role, rules]) => [
    role,
    rules === null ? null : {
      ...(hasOwn(rules, "model") ? { model: rules.model } : {}),
      ...(hasOwn(rules, "fallbackModels")
        ? { fallbackModels: rules.fallbackModels === null ? null : [...(rules.fallbackModels ?? [])] }
        : {}),
      ...(hasOwn(rules, "thinking") ? { thinking: rules.thinking } : {}),
      ...(hasOwn(rules, "fast") ? { fast: rules.fast } : {}),
      ...(hasOwn(rules, "circuit") ? { circuit: rules.circuit === null ? null : { ...rules.circuit } } : {}),
      ...(hasOwn(rules, "taskType") ? { taskType: rules.taskType } : {}),
    },
  ]));
}

export function cloneTypeMeta(typeMeta: ModelRoutingRules["typeMeta"]): ModelRoutingRules["typeMeta"] {
  if (!typeMeta) return undefined;
  return Object.fromEntries(Object.entries(typeMeta).map(([taskType, meta]) => [
    taskType,
    meta === null ? null : { keywords: meta.keywords === null ? null : [...(meta.keywords ?? [])] },
  ]));
}

export function cloneRules(rules: ModelRoutingRules): ModelRoutingRules {
  const fallbackMappings = rules.fallbackMappings
    ? Object.fromEntries(Object.entries(rules.fallbackMappings).map(([taskType, models]) => [
      taskType,
      Array.isArray(models) ? [...models] : models,
    ]))
    : undefined;
  const roleMappings = cloneRoleMappings(rules.roleMappings);
  const typeMeta = cloneTypeMeta(rules.typeMeta);
  return {
    mappings: { ...rules.mappings },
    ...(fallbackMappings && Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...rules.thinkingLevels },
    ...(rules.fastModes ? { fastModes: { ...rules.fastModes } } : {}),
    ...(roleMappings && Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(typeMeta && Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

export function assertKnownKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new Error(`Unknown ${label} field: ${unknown}`);
}

export function assertRoleName(role: string): void {
  if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role)) {
    throw new Error(`Invalid teammate role mapping: ${role}`);
  }
}

export function validateRoleMappings(value: unknown, label: string, allowFast = false): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label} roleMappings`);
  for (const [role, rawRules] of Object.entries(value as Record<string, unknown>)) {
    assertRoleName(role);
    if (rawRules === null) continue;
    if (!rawRules || typeof rawRules !== "object" || Array.isArray(rawRules)) {
      throw new Error(`Invalid ${label} role mapping: ${role}`);
    }
    const rules = rawRules as Record<string, unknown>;
    assertKnownKeys(rules, ["model", "fallbackModels", "thinking", "circuit", "taskType", ...(allowFast ? ["fast"] : [])], `Role ${role}`);
    if (rules.model !== undefined && rules.model !== null && (typeof rules.model !== "string" || !rules.model.trim())) {
      throw new Error(`Invalid ${label} role model: ${role}`);
    }
    if (rules.fallbackModels !== undefined && rules.fallbackModels !== null
      && (!Array.isArray(rules.fallbackModels)
        || rules.fallbackModels.some((model) => typeof model !== "string" || !model.trim()))) {
      throw new Error(`Invalid ${label} role fallback mapping: ${role}`);
    }
    if (rules.thinking !== undefined && rules.thinking !== null && !parseTeammateThinkingLevel(rules.thinking)) {
      throw new Error(`Invalid ${label} role thinking level: ${role}`);
    }
    if (rules.fast !== undefined && rules.fast !== null && typeof rules.fast !== "boolean") {
      throw new Error(`Invalid ${label} role Fast mode: ${role}`);
    }
    if (rules.taskType !== undefined && rules.taskType !== null && !parseTeammateTaskType(rules.taskType)) {
      throw new Error(`Invalid ${label} role task type: ${role}`);
    }
    if (rules.circuit !== undefined && rules.circuit !== null) {
      if (!rules.circuit || typeof rules.circuit !== "object" || Array.isArray(rules.circuit)) {
        throw new Error(`Invalid ${label} role circuit policy: ${role}`);
      }
      const circuit = rules.circuit as Record<string, unknown>;
      assertKnownKeys(circuit, ["threshold", "cooldownMs"], `Role ${role} circuit`);
      if (circuit.threshold !== undefined
        && (typeof circuit.threshold !== "number" || !Number.isInteger(circuit.threshold) || circuit.threshold < 1)) {
        throw new Error(`Invalid ${label} role circuit threshold: ${role}`);
      }
      if (circuit.cooldownMs !== undefined
        && (typeof circuit.cooldownMs !== "number" || !Number.isFinite(circuit.cooldownMs) || circuit.cooldownMs < 0)) {
        throw new Error(`Invalid ${label} role circuit cooldown: ${role}`);
      }
    }
  }
}

export function validateV3Rules(value: Record<string, unknown>, label: string, allowFast = false): void {
  assertKnownKeys(value, ["mappings", "fallbackMappings", "thinkingLevels", "roleMappings", "typeMeta", ...(allowFast ? ["fastModes"] : [])], label);
  if (!value.mappings || typeof value.mappings !== "object" || Array.isArray(value.mappings)
    || !value.thinkingLevels || typeof value.thinkingLevels !== "object" || Array.isArray(value.thinkingLevels)
    || (value.fallbackMappings !== undefined
      && (!value.fallbackMappings || typeof value.fallbackMappings !== "object" || Array.isArray(value.fallbackMappings)))) {
    throw new Error(`Invalid ${label}`);
  }
  for (const [taskType, model] of Object.entries(value.mappings as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (model !== null && (typeof model !== "string" || !model.trim()))) {
      throw new Error(`Invalid ${label} mapping: ${taskType}`);
    }
  }
  for (const [taskType, models] of Object.entries((value.fallbackMappings ?? {}) as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (models !== null && (!Array.isArray(models)
        || models.some((model) => typeof model !== "string" || !model.trim())))) {
      throw new Error(`Invalid ${label} fallback mapping: ${taskType}`);
    }
  }
  for (const [taskType, thinking] of Object.entries(value.thinkingLevels as Record<string, unknown>)) {
    if (!parseTeammateTaskType(taskType)
      || (thinking !== null && !parseTeammateThinkingLevel(thinking))) {
      throw new Error(`Invalid ${label} thinking level: ${taskType}`);
    }
  }
  if (value.fastModes !== undefined) {
    if (!value.fastModes || typeof value.fastModes !== "object" || Array.isArray(value.fastModes)) throw new Error(`Invalid ${label} fastModes`);
    for (const [taskType, fast] of Object.entries(value.fastModes as Record<string, unknown>)) {
      if (!parseTeammateTaskType(taskType) || (fast !== null && typeof fast !== "boolean")) throw new Error(`Invalid ${label} Fast mode: ${taskType}`);
    }
  }
  validateRoleMappings(value.roleMappings, label, allowFast);
  if (value.typeMeta !== undefined) {
    if (!value.typeMeta || typeof value.typeMeta !== "object" || Array.isArray(value.typeMeta)) {
      throw new Error(`Invalid ${label} typeMeta`);
    }
    for (const [taskType, rawMeta] of Object.entries(value.typeMeta as Record<string, unknown>)) {
      if (!parseTeammateTaskType(taskType)) throw new Error(`Invalid ${label} typeMeta type: ${taskType}`);
      if (rawMeta === null) continue;
      if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) {
        throw new Error(`Invalid ${label} typeMeta entry: ${taskType}`);
      }
      const meta = rawMeta as Record<string, unknown>;
      assertKnownKeys(meta, ["keywords"], `Type ${taskType} meta`);
      if (meta.keywords !== undefined && meta.keywords !== null
        && (!Array.isArray(meta.keywords)
          || meta.keywords.some((keyword) => typeof keyword !== "string" || !keyword.trim()))) {
        throw new Error(`Invalid ${label} typeMeta keywords: ${taskType}`);
      }
    }
  }
}

/** Validate the canonical persisted V3 routing-rules grammar without normalizing it. */
export function validateModelRoutingV3Rules(value: unknown): asserts value is ModelRoutingRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid model routing v3 rules");
  }
  validateV3Rules(value as Record<string, unknown>, "model routing v3 rules");
}

/** Validate the V4 independent Fast routing map and role overrides. */
export function validateModelRoutingV4Rules(value: unknown): asserts value is ModelRoutingRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid model routing v4 rules");
  validateV3Rules(value as Record<string, unknown>, "model routing v4 rules", true);
}

export function normalizeRules(value: unknown): ModelRoutingRules {
  const parsed = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const mappings: Partial<Record<TeammateTaskType, string | null>> = {};
  const fallbackMappings: Partial<Record<TeammateTaskType, string[] | null>> = {};
  const thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>> = {};
  const fastModes: Partial<Record<TeammateTaskType, boolean | null>> = {};
  const roleMappings: Record<string, ModelRoutingRoleRules | null> = {};
  const rawMappings = parsed.mappings && typeof parsed.mappings === "object" && !Array.isArray(parsed.mappings)
    ? parsed.mappings as Record<string, unknown>
    : {};
  const rawFallbacks = parsed.fallbackMappings && typeof parsed.fallbackMappings === "object" && !Array.isArray(parsed.fallbackMappings)
    ? parsed.fallbackMappings as Record<string, unknown>
    : {};
  const rawThinking = parsed.thinkingLevels && typeof parsed.thinkingLevels === "object" && !Array.isArray(parsed.thinkingLevels)
    ? parsed.thinkingLevels as Record<string, unknown>
    : {};
  const rawRoleMappings = parsed.roleMappings && typeof parsed.roleMappings === "object" && !Array.isArray(parsed.roleMappings)
    ? parsed.roleMappings as Record<string, unknown>
    : {};
  const rawFast = parsed.fastModes && typeof parsed.fastModes === "object" && !Array.isArray(parsed.fastModes)
    ? parsed.fastModes as Record<string, unknown> : {};
  for (const [key, fast] of Object.entries(rawFast)) {
    const taskType = parseTeammateTaskType(key);
    if (taskType && (fast === null || typeof fast === "boolean")) fastModes[taskType] = fast;
  }
  const taskTypes = new Set([...Object.keys(rawMappings), ...Object.keys(rawFallbacks), ...Object.keys(rawThinking)]);
  for (const rawTaskType of taskTypes) {
    const taskType = parseTeammateTaskType(rawTaskType);
    if (!taskType) continue;
    const model = rawMappings[rawTaskType];
    if (typeof model === "string" && model.trim()) mappings[taskType] = model.trim();
    else if (model === null) mappings[taskType] = null;
    const fallback = rawFallbacks[rawTaskType];
    if (fallback === null) fallbackMappings[taskType] = null;
    else if (Array.isArray(fallback)) {
      fallbackMappings[taskType] = [...new Set(fallback
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean))];
    }
    const thinking = rawThinking[rawTaskType];
    if (thinking === null) thinkingLevels[taskType] = null;
    else {
      const normalizedThinking = parseTeammateThinkingLevel(thinking);
      if (normalizedThinking) thinkingLevels[taskType] = normalizedThinking;
    }
  }
  for (const [role, rawRoleRules] of Object.entries(rawRoleMappings)) {
    if (!/^[a-z][a-z0-9._-]{0,63}$/.test(role)) continue;
    if (rawRoleRules === null) {
      roleMappings[role] = null;
      continue;
    }
    if (!rawRoleRules || typeof rawRoleRules !== "object" || Array.isArray(rawRoleRules)) continue;
    const rules = rawRoleRules as Record<string, unknown>;
    const normalized: ModelRoutingRoleRules = {};
    if (typeof rules.model === "string" && rules.model.trim()) normalized.model = rules.model.trim();
    else if (rules.model === null) normalized.model = null;
    if (rules.fallbackModels === null) normalized.fallbackModels = null;
    else if (Array.isArray(rules.fallbackModels)) {
      normalized.fallbackModels = [...new Set(rules.fallbackModels
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean))];
    }
    if (rules.thinking === null) normalized.thinking = null;
    else {
      const normalizedThinking = parseTeammateThinkingLevel(rules.thinking);
      if (normalizedThinking) normalized.thinking = normalizedThinking;
    }
    if (rules.fast === null || typeof rules.fast === "boolean") normalized.fast = rules.fast;
    if (rules.taskType === null) normalized.taskType = null;
    else {
      const normalizedTaskType = parseTeammateTaskType(rules.taskType);
      if (normalizedTaskType) normalized.taskType = normalizedTaskType;
    }
    if (rules.circuit === null) normalized.circuit = null;
    else if (rules.circuit && typeof rules.circuit === "object" && !Array.isArray(rules.circuit)) {
      const circuit = rules.circuit as Record<string, unknown>;
      const normalizedCircuit: ModelCircuitPolicy = {};
      if (typeof circuit.threshold === "number" && Number.isInteger(circuit.threshold) && circuit.threshold >= 1) {
        normalizedCircuit.threshold = circuit.threshold;
      }
      if (typeof circuit.cooldownMs === "number" && Number.isFinite(circuit.cooldownMs) && circuit.cooldownMs >= 0) {
        normalizedCircuit.cooldownMs = circuit.cooldownMs;
      }
      if (normalizedCircuit.threshold !== undefined || normalizedCircuit.cooldownMs !== undefined) {
        normalized.circuit = normalizedCircuit;
      }
    }
    roleMappings[role] = normalized;
  }
  const typeMeta: Record<string, ModelRoutingTypeMeta | null> = {};
  const rawTypeMeta = parsed.typeMeta && typeof parsed.typeMeta === "object" && !Array.isArray(parsed.typeMeta)
    ? parsed.typeMeta as Record<string, unknown>
    : {};
  for (const [taskType, rawMeta] of Object.entries(rawTypeMeta)) {
    const normalizedTaskType = parseTeammateTaskType(taskType);
    if (!normalizedTaskType) continue;
    if (rawMeta === null) {
      typeMeta[normalizedTaskType] = null;
      continue;
    }
    if (!rawMeta || typeof rawMeta !== "object" || Array.isArray(rawMeta)) continue;
    const meta = rawMeta as Record<string, unknown>;
    const normalizedMeta: ModelRoutingTypeMeta = {};
    if (meta.keywords !== null && Array.isArray(meta.keywords)) {
      const keywords = [...new Set(meta.keywords
        .filter((keyword): keyword is string => typeof keyword === "string")
        .map((keyword) => keyword.trim().toLowerCase())
        .filter(Boolean))];
      if (keywords.length > 0) normalizedMeta.keywords = keywords;
    }
    if (normalizedMeta.keywords !== undefined) {
      typeMeta[normalizedTaskType] = normalizedMeta;
    }
  }
  return {
    mappings,
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels,
    ...(Object.keys(fastModes).length > 0 ? { fastModes } : {}),
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

export function mergeRules(base: ModelRoutingRules, overrides: ModelRoutingRules): ModelRoutingRules {
  const fallbackMappings = { ...base.fallbackMappings, ...overrides.fallbackMappings };
  const roleMappings: Record<string, ModelRoutingRoleRules | null> = {
    ...(base.roleMappings ?? {}),
  };
  for (const [role, override] of Object.entries(overrides.roleMappings ?? {})) {
    if (override === null) {
      roleMappings[role] = null;
      continue;
    }
    const inherited = roleMappings[role];
    roleMappings[role] = {
      ...(inherited && inherited !== null ? inherited : {}),
      ...override,
      ...(override.fallbackModels !== undefined
        ? { fallbackModels: override.fallbackModels === null ? null : [...override.fallbackModels] }
        : {}),
    };
  }
  const typeMeta: Record<string, ModelRoutingTypeMeta | null> = {
    ...(base.typeMeta ?? {}),
    ...(overrides.typeMeta ?? {}),
  };
  return {
    mappings: { ...base.mappings, ...overrides.mappings },
    ...(Object.keys(fallbackMappings).length > 0 ? { fallbackMappings } : {}),
    thinkingLevels: { ...base.thinkingLevels, ...overrides.thinkingLevels },
    ...((base.fastModes || overrides.fastModes) ? { fastModes: { ...base.fastModes, ...overrides.fastModes } } : {}),
    ...(Object.keys(roleMappings).length > 0 ? { roleMappings } : {}),
    ...(Object.keys(typeMeta).length > 0 ? { typeMeta } : {}),
  };
}

export function hasRules(rules: ModelRoutingRules): boolean {
  return Object.keys(rules.mappings).length > 0
    || Object.keys(rules.fallbackMappings ?? {}).length > 0
    || Object.keys(rules.thinkingLevels).length > 0
    || Object.keys(rules.fastModes ?? {}).length > 0
    || Object.keys(rules.roleMappings ?? {}).length > 0
    || Object.keys(rules.typeMeta ?? {}).length > 0;
}

export function normalizeRoleRulesInput(rules: ModelRoutingRoleRules | null): ModelRoutingRoleRules | null {
  if (rules === null) return null;
  const normalized: ModelRoutingRoleRules = {};
  if (rules.model !== undefined) {
    if (rules.model === null) normalized.model = null;
    else if (rules.model.trim()) normalized.model = rules.model.trim();
    else throw new Error("Role model must not be empty");
  }
  if (rules.fallbackModels !== undefined) {
    normalized.fallbackModels = rules.fallbackModels === null
      ? null
      : [...new Set(rules.fallbackModels.map((model) => model.trim()).filter(Boolean))];
  }
  if (rules.thinking !== undefined) normalized.thinking = rules.thinking;
  if (rules.fast !== undefined) {
    if (rules.fast !== null && typeof rules.fast !== "boolean") throw new Error("Role Fast must be boolean or null");
    normalized.fast = rules.fast;
  }
  if (rules.taskType !== undefined) {
    if (rules.taskType === null) normalized.taskType = null;
    else {
      const taskType = parseTeammateTaskType(rules.taskType);
      if (!taskType) throw new Error(`Invalid role task type: ${rules.taskType}`);
      normalized.taskType = taskType;
    }
  }
  if (rules.circuit !== undefined) {
    if (rules.circuit === null) {
      normalized.circuit = null;
    } else {
      const circuit: ModelCircuitPolicy = {};
      if (rules.circuit.threshold !== undefined) {
        if (!Number.isInteger(rules.circuit.threshold) || rules.circuit.threshold < 1) {
          throw new Error("Role circuit threshold must be a positive integer");
        }
        circuit.threshold = rules.circuit.threshold;
      }
      if (rules.circuit.cooldownMs !== undefined) {
        if (!Number.isFinite(rules.circuit.cooldownMs) || rules.circuit.cooldownMs < 0) {
          throw new Error("Role circuit cooldownMs must be a non-negative number");
        }
        circuit.cooldownMs = rules.circuit.cooldownMs;
      }
      normalized.circuit = circuit;
    }
  }
  return normalized;
}

export function normalizeTypeMetaInput(meta: ModelRoutingTypeMeta | null): ModelRoutingTypeMeta {
  const normalized: ModelRoutingTypeMeta = {};
  if (meta === null) return normalized;
  if (meta.keywords !== undefined) {
    if (meta.keywords === null) return normalized;
    if (!Array.isArray(meta.keywords)) throw new Error("Type keywords must be an array");
    const keywords = [...new Set(meta.keywords
      .map((keyword) => keyword.trim().toLowerCase())
      .filter(Boolean))];
    if (keywords.length > 0) normalized.keywords = keywords;
  }
  return normalized;
}

/**
 * Effective metadata for a task type: the user-defined `typeMeta` keywords
 * from the routing config, if any (custom types have no built-in meta).
 */
export function resolveTaskTypeMeta(
  config: ModelRoutingConfig,
  taskType: TeammateTaskType,
): { keywords?: string[] } | undefined {
  const override = config.typeMeta?.[taskType];
  if (!override || override === null || !override.keywords || override.keywords.length === 0) return undefined;
  return { keywords: [...override.keywords] };
}

export function inferTaskType(input: TaskTypeInput): TeammateTaskType | undefined {
  if (input.taskType) return input.taskType;

  const agent = input.agent?.toLowerCase() ?? "";
  if (agent.includes("explorer") || agent === "explore") return "explore";
  if (agent.includes("analyst") || agent.includes("research")) return "analysis";
  if (agent.includes("debug")) return "debug";
  if (agent.includes("planner") || agent.includes("architect")) return "planning";
  if (agent.includes("review")) return "review";
  if (agent.includes("test") || agent.includes("qa")) return "testing";
  if (agent.includes("developer") || agent.includes("implement") || agent.includes("worker")) return "development";

  const task = input.task?.toLowerCase() ?? "";
  if (/\b(debug|bug|root cause|reproduce|stack trace)\b/.test(task)) return "debug";
  if (/\b(plan|architecture design|migration strategy|break down)\b/.test(task)) return "planning";
  if (/\b(review|audit|assess quality|security risk)\b/.test(task)) return "review";
  if (/\b(test|coverage|regression|qa)\b/.test(task)) return "testing";
  if (/\b(implement|develop|refactor|fix|write code)\b/.test(task)) return "development";
  if (/\b(find|locate|search|where is|call site|definition)\b/.test(task)) return "explore";
  if (/\b(analyze|trace|investigate|explain)\b/.test(task)) return "analysis";
  return undefined;
}

export function roleRules(config: ModelRoutingConfig, input: TaskTypeInput): ModelRoutingRoleRules | undefined {
  const role = input.agent?.trim();
  if (!role) return undefined;
  const configured = config.roleMappings?.[role];
  return configured && configured !== null ? configured : undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a task prompt against configured type keywords: the first type whose
 * keyword appears as a whole word wins, in discovery order (built-ins first,
 * then custom types alphabetically). Keywords are lowercased at normalize.
 */
export function inferTaskTypeByKeywords(
  config: ModelRoutingConfig,
  task: string | undefined,
): TeammateTaskType | undefined {
  const text = task?.toLowerCase() ?? "";
  if (!text) return undefined;
  for (const taskType of discoverRoutingTaskTypesFromConfig(config)) {
    const meta = config.typeMeta?.[taskType];
    if (!meta || !meta.keywords || meta.keywords.length === 0) continue;
    for (const keyword of meta.keywords) {
      if (new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(text)) return taskType;
    }
  }
  return undefined;
}

export function mappedThinking(config: ModelRoutingConfig, input: TaskTypeInput): TeammateThinkingLevel | undefined {
  const taskType = input.taskType;
  if (taskType) {
    const configured = config.thinkingLevels[taskType];
    if (configured) return configured;
  }
  return roleRules(config, input)?.thinking ?? undefined;
}

export function discoverRoutingTaskTypesFromConfig(config: ModelRoutingConfig): TeammateTaskType[] {
  const taskTypes = new Set<TeammateTaskType>(TEAMMATE_TASK_TYPES);
  for (const taskType of [
    ...Object.keys(config.mappings),
    ...Object.keys(config.fallbackMappings ?? {}),
    ...Object.keys(config.thinkingLevels),
    ...Object.keys(config.fastModes ?? {}),
    ...Object.keys(config.typeMeta ?? {}),
  ]) {
    const normalized = parseTeammateTaskType(taskType);
    if (normalized) taskTypes.add(normalized);
  }
  const builtins = new Set<string>(TEAMMATE_TASK_TYPES);
  return [...taskTypes].sort((left, right) => {
    const leftIndex = TEAMMATE_TASK_TYPES.indexOf(left as typeof TEAMMATE_TASK_TYPES[number]);
    const rightIndex = TEAMMATE_TASK_TYPES.indexOf(right as typeof TEAMMATE_TASK_TYPES[number]);
    if (builtins.has(left) && builtins.has(right)) return leftIndex - rightIndex;
    if (builtins.has(left)) return -1;
    if (builtins.has(right)) return 1;
    return left.localeCompare(right);
  });
}

export function createModelRoutingEligibility(input: readonly (string | TeammateModelCapability)[] | undefined, authority?: DispatchAuthorityProjection): EligibilitySnapshot {
  const catalog = input ?? (authority ? [...authority.routesByRegistrationId.values()].map(route => ({id: route.modelRegistrationId, ...route.capabilities})) : undefined);
  const entries = catalog?.map(value => typeof value === "string" ? { id: value } : value).map(value => ({
    id: canonical(value.id, authority), reasoning: value.reasoning ?? null, thinkingLevels: value.thinkingLevels ?? null, input: value.input ?? null,
  })) ?? [];
  return { state: catalog === undefined ? "unknown" : "known", revision: snapshotHash({entries, authority: authority?.hash}),
    modelIds: [...new Set(entries.map(value => value.id))],
    identity: authority ? {kind: "registered", projectionHash: authority.hash} : {kind: "native"} };
}

export function deriveRoleSelectionSource<Role extends ModelRoutingRoleDefinition>(agent: string, role: Role, state: ModelRoutingState,
  options: { cwd: string; configPath: string; taskType?: string; authority?: DispatchAuthorityProjection;
    defaultSource?: Readonly<{ kind: "host-builtin-inherit"; model: string; roleSourceIdentity: string }> }) {
  const { cwd, configPath, taskType, authority } = options;
  const config = state.config;
  // Fixed and USER role declarations establish authority. A host may additionally
  // supply one captured logical default for a proven model-less builtin.
  // Project/session overlays and task mappings remain selectors, never grants.
  const baseRules = state.global.profiles[config.profileId]?.roleMappings?.[agent];
  const rules = roleRules(config, {agent});
  const chain = (model?: string | null, fallbacks?: readonly string[] | null) =>
    [...new Set([model, ...(fallbacks ?? [])].filter((id): id is string => !!id).map(id => canonical(id, authority)))];
  const fixed = chain(role.model, role.fallbackModels);
  const declaresModels = (value: ModelRoutingRoleRules | null | undefined) =>
    value === null || (value !== undefined && (hasOwn(value, "model") || hasOwn(value, "fallbackModels")));
  const clearsModels = (value: ModelRoutingRoleRules | null | undefined) =>
    value === null || (value !== undefined && declaresModels(value)
      && !(typeof value.model === "string" && value.model.length > 0)
      && !(Array.isArray(value.fallbackModels) && value.fallbackModels.length > 0));
  const inherited = !fixed.length && !declaresModels(baseRules) && !clearsModels(config.roleMappings?.[agent])
    ? options.defaultSource : undefined;
  // Canonicalize only an adopted default; an unrelated host alias cannot affect a fixed/USER role.
  const approved = fixed.length ? fixed : inherited ? chain(inherited.model) : chain(baseRules?.model, baseRules?.fallbackModels);
  const effective = rules?.model != null || rules?.fallbackModels != null
    ? chain(rules.model ?? approved[0], rules.fallbackModels ?? approved.slice(1)) : approved;
  for (const id of effective) if (!approved.includes(id)) throw new Error(`ModelRole: candidate is outside role ${agent}`);
  const typeModel = taskType ? config.mappings[taskType] : undefined;
  const typeFallbacks = taskType ? config.fallbackMappings?.[taskType] : undefined;
  // Defaults are selectors. Keep their raw presence for the frozen revision; the
  // host's canonical adapter resolves only the fields selection actually adopts.
  const taskDefaults: TaskSelectionDefaults = {
    ...(taskType && hasOwn(config.mappings, taskType) ? { model: typeModel } : {}),
    ...(taskType && config.fallbackMappings && hasOwn(config.fallbackMappings, taskType)
      ? { fallbackModels: typeFallbacks == null ? typeFallbacks : [...typeFallbacks] } : {}),
  };
  const taskModels = typeModel ? [...new Set([typeModel, ...(typeFallbacks ?? [])])] : undefined;
  const snapshot: RoleSnapshot = {role: agent, candidates: effective,
    revision: snapshotHash({cwd, configPath, role, approved, baseRules, rules, inherited, taskType, taskDefaults, profileId: config.profileId,
      authority: authority?.hash})};
  // Describes the existing source only. This is not deployment authority:
  // the Host must separately bind its trusted target and original request.
  const sourceProvenance = Object.freeze({
    kind: fixed.length ? "fixed" as const : declaresModels(baseRules) ? "user" as const
      : inherited ? "host-builtin-inherit" as const : "missing-or-cleared" as const,
    roleSourceIdentity: inherited?.roleSourceIdentity,
    hasDeclaredModelPolicy: role.model !== undefined || role.fallbackModels !== undefined
      || declaresModels(baseRules) || declaresModels(config.roleMappings?.[agent])
      || hasOwn(taskDefaults, "model") || hasOwn(taskDefaults, "fallbackModels")
      || Reflect.get(role, "fixedProvider") !== undefined || Reflect.get(role, "provider") !== undefined,
    onlyImplicitHostDefault: inherited !== undefined
      && role.model === undefined && role.fallbackModels === undefined
      && !declaresModels(baseRules) && !declaresModels(config.roleMappings?.[agent])
      && !hasOwn(taskDefaults, "model") && !hasOwn(taskDefaults, "fallbackModels")
      && Reflect.get(role, "fixedProvider") === undefined && Reflect.get(role, "provider") === undefined,
  });
  return {role, config, snapshot, taskModels, taskDefaults, sourceProvenance};
}

export function resolveRoutingState(global: GlobalModelRoutingStore, project: ProjectModelRoutingStore, session?: SessionModelRoutingStore): ModelRoutingState {
  const requestedProfile = project.activeProfile ?? global.defaultProfile;
  const missingProfile = hasOwn(global.profiles, requestedProfile) ? undefined : requestedProfile;
  const profileId = missingProfile ? global.defaultProfile : requestedProfile;
  const profile = global.profiles[profileId];
  let rules = project.applyOverrides ? mergeRules(profile, project.overrides) : cloneRules(profile);
  if (session && hasRules(session.rules)) rules = mergeRules(rules, session.rules);
  return { global, project, config: { version: 4, profileId, profileName: profile.name,
    projectOverridesEnabled: project.applyOverrides, ...rules },
    smartMode: global.smartMode ?? 'off', askBeforeDispatch: global.askBeforeDispatch === true,
    requestedProfile, ...(missingProfile ? { missingProfile } : {}) };
}

export function resolveTaskRoutingFields(input: { taskFast?: boolean; topLevelFast?: boolean; taskThinking?: unknown;
  topLevelThinking?: TeammateThinkingLevel; taskType?: TeammateTaskType; agent: string;
  role: ModelRoutingRoleDefinition; config: ModelRoutingConfig }): { fast: boolean | undefined; thinking: TeammateThinkingLevel | undefined } {
  const { taskFast, topLevelFast, taskThinking, topLevelThinking, taskType, agent, role, config } = input;
  return { fast: taskFast ?? topLevelFast ?? (taskType ? config.fastModes?.[taskType] : undefined)
    ?? roleRules(config, {agent})?.fast ?? role.fast,
    thinking: parseTeammateThinkingLevel(taskThinking) ?? topLevelThinking ?? mappedThinking(config, {taskType, agent}) };
}
