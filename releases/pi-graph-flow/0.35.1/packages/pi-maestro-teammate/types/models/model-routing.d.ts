import { type TeammateSmartMode, type ModelRoutingRoleRules, type ModelRoutingTypeMeta, type ModelRoutingRules, type GlobalModelRoutingStore, type ProjectModelRoutingStore, type ModelRoutingConfig, type ModelRoutingState, type ModelRoutingProfileSummary } from 'pi-graph-model-role';
export { validateModelRoutingV3Rules, validateModelRoutingV4Rules, resolveTaskTypeMeta, inferTaskType, inferTaskTypeByKeywords, isModelRoutingProfileId, resolveModelRegistrationRouting, canHotSwitchModelRegistration, TEAMMATE_SMART_MODES } from 'pi-graph-model-role';
export type { ModelRoutingRoleRules, ModelRoutingTypeMeta, ModelRoutingRules, ModelRoutingProfile, GlobalModelRoutingStore, ProjectModelRoutingStore, ModelRoutingConfig, ModelRoutingState, TaskTypeInput, SessionModelRoutingStore, ModelRoutingProfileSummary, ModelRegistrationRoutingInput, ResolvedModelRegistrationCandidate, ResolvedModelRegistrationRouting, TeammateSmartMode } from 'pi-graph-model-role';
import type { TeammateModelCapability } from "./model-catalog.ts";
import { type SelectionDecision } from "pi-graph-model-role";
import type { RunTeammateParams } from "../runs/execution.ts";
import { type AgentConfig } from "../agents/agents.ts";
import { type TeammateTaskType } from "../shared/task-types.ts";
import { type TeammateThinkingLevel } from "../shared/thinking.ts";
import type { ModelCircuitBreaker, ModelHealthCoordinator } from "./model-circuit-breaker.ts";
import type { DispatchAuthorityProjection } from "./model-registry.ts";
export { TEAMMATE_TASK_TYPES, parseTeammateTaskType } from "../shared/task-types.ts";
export type { TeammateTaskType } from "../shared/task-types.ts";
export declare const TEAMMATE_TASK_TYPE_META: Record<string, {
    label: string;
    roles: string;
    description: string;
}>;
export declare function getGlobalModelRoutingPath(agentDir?: string): string;
export declare function getProjectModelRoutingPath(cwd: string): string;
/**
 * Per-session routing overrides file path. The sessionId is sanitized to a
 * filesystem-safe slug so an untrusted id cannot escape the `.pi/` directory.
 * Session overrides stack on top of project overrides at the task-type mapping
 * layer and are scoped to the single Pi session that wrote them.
 */
export declare function getSessionModelRoutingPath(cwd: string, sessionId: string): string;
/**
 * Persist a session-scoped routing override. Session overrides stack on top
 * of project overrides (and the active profile) and apply only to the single
 * Pi session identified by `sessionId`. The file is written atomically under
 * the same lock protocol as the project config. A corrupted session file is
 * ignored at read time, so a bad write never blocks dispatch.
 */
export declare function saveSessionModelRoutingOverrides(cwd: string, sessionId: string, rules: ModelRoutingRules, globalFilePath?: string): ModelRoutingConfig;
/** Persist the smart model-selection strategy on the global teammate model config. */
export declare function setGlobalSmartMode(value: TeammateSmartMode | boolean, globalFilePath?: string): TeammateSmartMode;
/** Effective smart model-selection strategy without a cwd (global store only). */
export declare function getGlobalSmartMode(globalFilePath?: string): TeammateSmartMode;
/**
 * Persist the ask-before-dispatch flag on the global teammate model config.
 * The flag is user-level (not per profile/project): it controls whether the
 * root teammate tool asks the user to confirm or pick model provider/thinking
 * before every dispatch.
 */
export declare function setGlobalAskBeforeDispatch(enabled: boolean, globalFilePath?: string): boolean;
/** Effective ask-before-dispatch flag without a cwd (global store only). */
export declare function getGlobalAskBeforeDispatch(globalFilePath?: string): boolean;
/** Effective monitoring-only background status heartbeat interval. */
export declare function getGlobalBackgroundStatusHeartbeatMs(globalFilePath?: string): number;
export declare function loadModelRoutingState(cwd: string, globalFilePath?: string, sessionId?: string): ModelRoutingState;
export declare function loadModelRoutingConfig(cwd: string, globalFilePath?: string, sessionId?: string): ModelRoutingConfig;
export interface ModelRoutingStorePair {
    global: GlobalModelRoutingStore;
    project: ProjectModelRoutingStore;
}
export interface ModelRoutingStoreContentPair {
    global: string;
    project: string;
}
/** @internal Shared persistence bridge for the unified Settings provider. */
export declare function loadModelRoutingStores(globalFilePath: string, projectFilePath: string): ModelRoutingStorePair;
/** @internal Publish a prepared Settings transaction through the routing lock/journal protocol. */
export declare function replaceModelRoutingStores(globalFilePath: string, projectFilePath: string, expected: ModelRoutingStorePair, next: ModelRoutingStorePair, expectedContent?: ModelRoutingStoreContentPair, restoreContent?: ModelRoutingStoreContentPair): ModelRoutingStorePair;
export declare function discoverRoutingTaskTypes(cwd: string, _agents?: readonly {
    taskType?: TeammateTaskType;
}[], loadedConfig?: ModelRoutingConfig): TeammateTaskType[];
export declare function saveProjectThinkingLevel(cwd: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectFastMode(cwd: string, taskType: TeammateTaskType, fast: boolean | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectModelMapping(cwd: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectFallbackMapping(cwd: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingConfig;
export declare function saveProjectRoleMapping(cwd: string, role: string, rules: ModelRoutingRoleRules | null, globalFilePath?: string): ModelRoutingConfig;
/** List saved routing templates with the current project's active selection. */
export declare function listModelRoutingProfiles(cwd: string, globalFilePath?: string): ModelRoutingProfileSummary[];
/** Resolve a stable Profile id or display name without changing the selection. */
export declare function resolveModelRoutingProfile(cwd: string, reference: string, globalFilePath?: string): ModelRoutingProfileSummary;
export declare function saveGlobalProfileModelMapping(cwd: string, profileId: string, taskType: TeammateTaskType, model: string | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileThinkingLevel(cwd: string, profileId: string, taskType: TeammateTaskType, thinking: TeammateThinkingLevel | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileFastMode(cwd: string, profileId: string, taskType: TeammateTaskType, fast: boolean | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileFallbackMapping(cwd: string, profileId: string, taskType: TeammateTaskType, models: string[] | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileRoleMapping(cwd: string, profileId: string, role: string, rules: ModelRoutingRoleRules | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileTypeRoles(cwd: string, profileId: string, taskType: TeammateTaskType, roles: readonly string[], globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileTypeMeta(cwd: string, profileId: string, taskType: TeammateTaskType, meta: ModelRoutingTypeMeta | null, globalFilePath?: string): ModelRoutingState;
export declare function saveGlobalProfileCustomType(cwd: string, profileId: string, taskType: TeammateTaskType, meta?: ModelRoutingTypeMeta | null, globalFilePath?: string): ModelRoutingState;
export declare function deleteGlobalProfileCustomType(cwd: string, profileId: string, taskType: TeammateTaskType, globalFilePath?: string): ModelRoutingState;
export declare function createGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function createAndActivateGlobalModelRoutingProfile(cwd: string, name: string, sourceProfileId?: string, globalFilePath?: string): ModelRoutingState;
export declare function renameGlobalModelRoutingProfile(cwd: string, profileId: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function setDefaultGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectActiveModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
export declare function activateModelRoutingProfile(cwd: string, reference: string, globalFilePath?: string): ModelRoutingState;
export declare function setProjectModelRoutingOverridesEnabled(cwd: string, enabled: boolean, globalFilePath?: string): ModelRoutingState;
export declare function clearProjectModelRoutingOverrides(cwd: string, globalFilePath?: string): ModelRoutingState;
export declare function promoteProjectModelRoutingOverrides(cwd: string, name: string, globalFilePath?: string): ModelRoutingState;
export declare function deleteGlobalModelRoutingProfile(cwd: string, profileId: string, globalFilePath?: string): ModelRoutingState;
type CatalogInput = readonly (string | TeammateModelCapability)[];
export declare function freezeRoleModelSelection(input: {
    agent: string;
    model?: string;
    fallbackModels?: string[];
    taskType?: string;
}, cwd: string, ids: CatalogInput | undefined, globalFilePath?: string, sessionId?: string, authority?: DispatchAuthorityProjection, inheritModel?: string): SelectionDecision;
export declare function verifyRoleModelSelection(decision: SelectionDecision, input: {
    agent: string;
    model?: string;
    fallbackModels?: string[];
}, ids: CatalogInput | undefined, actual: {
    cwd: string;
    role: AgentConfig;
    globalFilePath?: string;
    authority?: DispatchAuthorityProjection;
}): void;
/** A display/eligibility query only: deployment authorization is separate. */
export declare function isImplicitBuiltinModelSelection(decision: SelectionDecision | undefined): boolean;
/** Keeps the same private role source; no serializable default permit is issued. */
export declare function bindRoleDeploymentDefault(decision: SelectionDecision, ids: CatalogInput | undefined, actual: {
    cwd: string;
    role: AgentConfig;
    globalFilePath?: string;
}, readDeployment: () => string): () => void;
export declare function applyModelRouting(params: RunTeammateParams, cwd: string, availableModels?: CatalogInput, globalFilePath?: string, inheritModel?: string, sessionId?: string, authority?: DispatchAuthorityProjection): RunTeammateParams;
/**
 * Sync per-role circuit policies from the routing config onto a circuit
 * breaker. Circuit policies apply to the role's configured model; task-type
 * routes are selected per dispatch and do not bind back to roles. The breaker's
 * policy map is rebuilt from the config on every call, so removed policies do
 * not linger.
 */
export declare function syncModelCircuitPolicies(breaker: ModelCircuitBreaker, cwd: string, globalFilePath?: string): void;
/** Reconcile registry-mode health against the dispatch projection's stable hash. */
export declare function reconcileModelHealthProjection(health: ModelHealthCoordinator, projection: DispatchAuthorityProjection): boolean;
export interface ModelRegistryRefreshContext {
    modelRegistry?: {
        refresh?: () => Promise<unknown>;
    } | undefined;
}
/**
 * Await a coalesced refresh of the host model registry before reading its
 * getAvailable() snapshot. The sync snapshot is only rebuilt by refresh();
 * without it, models deleted from config/auth stay visible to catalog,
 * routing and modelCapabilities validation until unrelated code refreshes.
 */
export declare function refreshModelRegistry(ctx: ModelRegistryRefreshContext): Promise<void>;
/**
 * Configured routing targets that the current teammate catalog cannot reach.
 *
 * `mappedModel` skips unreachable targets silently (the dispatch then falls
 * back down the inheritance chain), so this is the one place an operator can
 * see that a task-type or role mapping names a model no gate currently
 * admits. Empty `availableModels` means "no catalog knowledge" and yields no
 * findings — absence of evidence must not read as breakage.
 */
export interface UnreachableRoutingTarget {
    kind: "taskType" | "role";
    key: string;
    model: string;
}
export declare function unreachableRoutingTargets(config: ModelRoutingConfig, availableModels: readonly string[]): UnreachableRoutingTarget[];
export declare function formatModelRoutingConfig(cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], globalFilePath?: string, availableModels?: readonly string[]): string;
export declare const TASK_TYPE_ROUTING_START_MARKER = "<!-- teammate-tasktype-routing:start -->";
export declare const TASK_TYPE_ROUTING_END_MARKER = "<!-- teammate-tasktype-routing:end -->";
export declare const SMART_MODEL_SELECTION_START_MARKER = "<!-- teammate-smart-model-selection:start -->";
export declare const SMART_MODEL_SELECTION_END_MARKER = "<!-- teammate-smart-model-selection:end -->";
/**
 * Inject concise taskType model-routing guidance for agents that can dispatch
 * teammates. Replaces an existing block in place so repeated injection stays
 * idempotent.
 */
export declare function appendTaskTypeRoutingContext(systemPrompt: string, cwd: string, agents?: readonly {
    taskType?: TeammateTaskType;
}[], globalFilePath?: string, availableModels?: readonly string[]): string;
/**
 * Inject the root-agent smart selection workflow without embedding volatile
 * benchmark data. model-availability remains the single runtime data source.
 */
export declare function appendSmartModelSelectionContext(systemPrompt: string, smartMode: TeammateSmartMode, askBeforeDispatch: boolean): string;
