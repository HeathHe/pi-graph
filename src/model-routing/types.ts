export type RoutingLevel = "L0" | "L1" | "L2" | "L3";
export type RoutingEnforcement = "shadow" | "require";
export type TaskRisk = "low" | "medium" | "high";
export type IdentityConfidence = "unknown" | "selected_only" | "runtime_reported" | "verified";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelInputModality = "text" | "image";

export interface ModelRegistryEntry {
	model: string;
	family: string;
	provider: string;
	providerDomain: string;
	aliases?: string[];
	thinkingLevels?: ThinkingLevel[];
	inputModalities?: ModelInputModality[];
}

export interface ModelRegistry {
	schemaVersion: 1;
	models: ModelRegistryEntry[];
}

export interface RoutingPolicyCandidate {
	model: string;
	thinking?: ThinkingLevel;
	level?: Exclude<RoutingLevel, "L3">;
}

export interface RoutingPolicyConstraints {
	excludeFamilies?: string[];
	excludeProviderDomains?: string[];
	requireCrossFamilyFromProducers?: boolean;
	requireProviderDomainSeparation?: boolean;
	allowAutomaticMax?: boolean;
	producerSource?: "active_main" | "accepted_manifests";
	minimumIdentityConfidence?: IdentityConfidence;
	highRiskMinimumIdentityConfidence?: IdentityConfidence;
	maximumAutomaticFallback?: Exclude<RoutingLevel, "L3">;
	requiredInputModalities?: ModelInputModality[];
}

export interface RoutingPolicyBudget {
	providerRetries?: number;
	modelDegradations?: number;
}

export interface RoutingProfile {
	candidates: RoutingPolicyCandidate[];
	constraints?: RoutingPolicyConstraints;
	budget?: RoutingPolicyBudget;
	enforcement?: RoutingEnforcement;
}

export interface RoutingPolicy {
	schemaVersion: 1;
	enforcement?: RoutingEnforcement;
	quarantinedProviderDomains?: string[];
	planningReviewProfiles?: {
		byPlannerProviderDomain?: Record<string, string>;
		byPlannerModelFamily?: Record<string, string>;
		defaultProfile?: string;
	};
	planningProfiles?: {
		tactical: string;
		strategic: string;
		strategicHighRisk: string;
	};
	agentProfiles?: Record<string, string>;
	maxAuthorizationIssuers?: Record<string, Record<string, string>>;
	profiles: Record<string, RoutingProfile>;
}

export interface ModelRoutingConfig {
	registry: ModelRegistry;
	policy: RoutingPolicy;
	configDigest: string;
	registryPath?: string;
	policyPath?: string;
}

export interface MaxAuthorization {
	authorizationId: string;
	issuer: string;
	keyId: string;
	taskBinding: string;
	model: string;
	thinking: "max";
	issuedAt: string;
	expiresAt: string;
	nonce: string;
	singleUse: true;
	signature: string;
}

export interface MaxAuthorizationUse {
	authorizationId: string;
	taskBinding: string;
	model: string;
	consumedAt: string;
}

export interface MaxAuthorizationStore {
	consume(authorization: MaxAuthorization, input: { taskBinding: string; model: string; now?: Date }): MaxAuthorizationUse;
}

export interface ProducerModelExecution {
	resolvedModel: string;
	modelFamily: string;
	providerDomain: string;
	identityConfidence: IdentityConfidence;
	taskId?: string;
}

export interface RoutingAvailableModel {
	provider: string;
	id: string;
	fullId?: string;
	reasoning?: boolean;
	input?: ReadonlyArray<ModelInputModality>;
}

export interface RoutingCandidateBinding {
	model: string;
	thinking?: ThinkingLevel;
	selectedModel: string;
	modelFamily: string;
	provider: string;
	providerDomain: string;
	fallbackLevel: Exclude<RoutingLevel, "L3">;
}

export interface RoutingDecisionSeal {
	algorithm: "sha256";
	digest: string;
}

export interface RoutingDecision {
	schemaVersion: 1;
	decisionId: string;
	createdAt: string;
	taskBinding: string;
	agent?: string;
	routingProfile: string;
	enforcement: RoutingEnforcement;
	fallbackLevel: RoutingLevel;
	requestedModel?: string;
	selectedModel?: string;
	modelFamily?: string;
	provider?: string;
	providerDomain?: string;
	candidateIndex?: number;
	eligibleCandidates: RoutingCandidateBinding[];
	producerFamilies: string[];
	producerProviderDomains: string[];
	identityConfidence: IdentityConfidence;
	budget: Required<RoutingPolicyBudget>;
	degradationIndex: number;
	parentDecisionId?: string;
	retryKind?: "provider" | "model_degrade" | "task_retry";
	maxAuthorizationUse?: MaxAuthorizationUse;
	configDigest: string;
	availableModelsDigest?: string;
	requiredInputModalities?: ModelInputModality[];
	reason: string;
	sealedAt: string;
	seal: RoutingDecisionSeal;
}

export interface RoutingEvaluationInput {
	taskBinding: string;
	agent?: string;
	routingProfile?: string;
	taskRisk?: TaskRisk;
	requestedModel?: string;
	producerExecutions?: ProducerModelExecution[];
	maxAuthorization?: MaxAuthorization;
	authorizationStore?: MaxAuthorizationStore;
	consumeMaxAuthorization?: boolean;
	enforcement?: RoutingEnforcement;
	previousDecision?: RoutingDecision;
	retryKind?: "provider" | "model_degrade" | "task_retry";
	availableModels?: ReadonlyArray<RoutingAvailableModel>;
	requireAvailableModels?: boolean;
	/** Per-dispatch capability requirement. It may only narrow the configured profile. */
	requiredInputModalities?: ModelInputModality[];
	now?: Date;
}

export interface ModelExecution {
	requestedModel: string;
	selectedModel: string;
	resolvedModel: string;
	modelFamily: string;
	providerDomain: string;
	fallbackLevel: RoutingLevel;
	identityConfidence: IdentityConfidence;
	attemptedModels?: string[];
	providerRequestId?: string;
	routingViolations?: string[];
}

export type RoutingObservationComparison = "match" | "mismatch" | "unrouted" | "blocked" | "error";

export interface RoutingObservation {
	observedAt: string;
	toolCallId: string;
	taskIndex: number;
	phase?: "decision" | "tool_result";
	agent?: string;
	routingProfile?: string;
	mode: RoutingEnforcement;
	decisionId?: string;
	observedInputModel?: string;
	resolvedModel?: string;
	attemptedModels?: string[];
	routingViolations?: string[];
	comparison?: RoutingObservationComparison;
	outcome?: "success" | "error";
	decision?: RoutingDecision;
	runtimeCompatibility?: "compatible" | "runtime_incompatible";
	controlledRoutingReady?: boolean;
	runtimeIssues?: string[];
	error?: string;
}
