import { ModelCircuitBreaker, ModelHealthCoordinator } from "pi-graph-provider-backend/health";
export { DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD, DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS, ModelCircuitBreaker, rankModelsByHealth, ModelHealthCoordinator, rankModelRegistrationsByHealth } from "pi-graph-provider-backend/health";
export type { ModelCircuitState, ModelCircuitPolicy, ModelCircuitBreakerOptions, ModelCircuitTransition, AcquiredModelCandidate, RejectedModelCandidate, ModelCandidateAcquisition, ModelCircuitSnapshot, ModelHealthScope, ModelHealthTarget, ModelHealthProjection, AcquiredModelHealthCandidate, RejectedModelHealthCandidate, ModelHealthCandidateAcquisition, ModelHealthSnapshot, ModelHealthCoordinatorOptions } from "pi-graph-provider-backend/health";
export declare const sharedModelCircuitBreaker: ModelCircuitBreaker;
export declare const sharedModelHealthCoordinator: ModelHealthCoordinator;
