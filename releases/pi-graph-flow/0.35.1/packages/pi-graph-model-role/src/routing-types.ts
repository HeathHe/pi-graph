import type { TeammateTaskType } from './task-types.ts';
import type { TeammateThinkingLevel } from './thinking.ts';
import type { ModelDispatchRoute, ModelDeploymentRoute } from './model-registry.ts';
/** Configuration shape only. The host owns live circuit state. */
export interface RoutingCircuitPolicy { threshold?: number; cooldownMs?: number; }
export interface ModelRoutingValidationBounds { heartbeatMinMs: number; heartbeatMaxMs: number; }
/** An already-read role; this type does not establish its authority. */
export interface ModelRoutingRoleDefinition { model?: string; fallbackModels?: readonly string[]; fast?: boolean; }
export interface ModelRoutingRoleRules {
  model?: string | null;
  fallbackModels?: string[] | null;
  thinking?: TeammateThinkingLevel | null;
  fast?: boolean | null;
  /** Per-role circuit breaker policy applied to the role's mapped model. */
  circuit?: RoutingCircuitPolicy | null;
  /** Legacy persisted metadata. Task types only affect routing when supplied by the dispatch. */
  taskType?: TeammateTaskType | null;
}

/** User-editable metadata for a task type: trigger keywords, like a skill description. */
export interface ModelRoutingTypeMeta {
  /** Trigger keywords defining when to use the type; `null` clears them. */
  keywords?: string[] | null;
}

export interface ModelRoutingRules {
  mappings: Partial<Record<TeammateTaskType, string | null>>;
  fallbackMappings?: Partial<Record<TeammateTaskType, string[] | null>>;
  thinkingLevels: Partial<Record<TeammateTaskType, TeammateThinkingLevel | null>>;
  fastModes?: Partial<Record<TeammateTaskType, boolean | null>>;
  roleMappings?: Record<string, ModelRoutingRoleRules | null>;
  /** Trigger-keyword metadata per task type; `null` clears an override. */
  typeMeta?: Record<string, ModelRoutingTypeMeta | null>;
}

export interface ModelRoutingProfile extends ModelRoutingRules {
  name: string;
}

export const TEAMMATE_SMART_MODES = ["off", "economy", "balanced", "sota"] as const;

export type TeammateSmartMode = typeof TEAMMATE_SMART_MODES[number];

export interface GlobalModelRoutingStore {
  version: 4;
  defaultProfile: string;
  profiles: Record<string, ModelRoutingProfile>;
  retiredProfileIds?: string[];
  /** Require the root agent to consult model-availability using this selection strategy. */
  smartMode?: Exclude<TeammateSmartMode, "off">;
  /** Ask the user to confirm/pick model provider + thinking before each root dispatch. */
  askBeforeDispatch?: boolean;
  /** User-level interval for monitoring-only status turns while background work remains active. */
  backgroundStatusHeartbeatMs?: number;
}

export interface ProjectModelRoutingStore {
  version: 4;
  activeProfile?: string;
  applyOverrides: boolean;
  overrides: ModelRoutingRules;
}

export interface ModelRoutingConfig extends ModelRoutingRules {
  version: 4;
  profileId: string;
  profileName: string;
  projectOverridesEnabled: boolean;
}

export interface ModelRoutingState {
  global: GlobalModelRoutingStore;
  project: ProjectModelRoutingStore;
  config: ModelRoutingConfig;
  /** Effective smart model-selection strategy (global store, default off). */
  smartMode: TeammateSmartMode;
  /** Effective ask-before-dispatch flag (global store, default off). */
  askBeforeDispatch: boolean;
  requestedProfile?: string;
  missingProfile?: string;
  changedProfileId?: string;
}

export interface TaskTypeInput {
  taskType?: TeammateTaskType;
  agent?: string;
  task?: string;
}

export interface SessionModelRoutingStore {
  version: 4;
  sessionId: string;
  createdAtMs: number;
  rules: ModelRoutingRules;
}

/** A saved teammate model routing template (called a Profile in the Control Center). */
export interface ModelRoutingProfileSummary {
  id: string;
  name: string;
  active: boolean;
  default: boolean;
}

export interface ModelRegistrationRoutingInput {
  model?: string;
  fallbackModels?: readonly string[];
  backend?: string;
  cwd?: string;
}

export interface ResolvedModelRegistrationCandidate {
  modelRegistrationId: string;
  route: ModelDispatchRoute;
  deployment: ModelDeploymentRoute;
}

export interface ResolvedModelRegistrationRouting {
  candidates: readonly ResolvedModelRegistrationCandidate[];
  requestedDeploymentId?: string;
  remoteLocation?: string;
}
