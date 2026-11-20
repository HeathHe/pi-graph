import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ModelCircuitBreaker, ModelHealthCoordinator } from "pi-graph-provider-backend/health";
export { DEFAULT_MODEL_CIRCUIT_BREAKER_THRESHOLD, DEFAULT_MODEL_CIRCUIT_BREAKER_COOLDOWN_MS, ModelCircuitBreaker, rankModelsByHealth, ModelHealthCoordinator, rankModelRegistrationsByHealth } from "pi-graph-provider-backend/health";
export type { ModelCircuitState, ModelCircuitPolicy, ModelCircuitBreakerOptions, ModelCircuitTransition, AcquiredModelCandidate, RejectedModelCandidate, ModelCandidateAcquisition, ModelCircuitSnapshot, ModelHealthScope, ModelHealthTarget, ModelHealthProjection, AcquiredModelHealthCandidate, RejectedModelHealthCandidate, ModelHealthCandidateAcquisition, ModelHealthSnapshot, ModelHealthCoordinatorOptions } from "pi-graph-provider-backend/health";

/** One original Host composition per physical installation, across SDK loader graphs. */
const compositionSource = realpathSync(fileURLToPath(import.meta.url));
const compositionKey = Symbol.for(`pi-maestro-teammate.model-health.v1:${compositionSource}`);
interface HealthComposition {
  readonly version: 1;
  readonly source: string;
  readonly breaker: ModelCircuitBreaker;
  readonly coordinator: ModelHealthCoordinator;
}
const processHost = globalThis as typeof globalThis & { [key: symbol]: unknown };
function readComposition(value: unknown): HealthComposition {
  if (!value || typeof value !== "object") throw new TypeError("Invalid model health Host composition");
  const composition = value as HealthComposition;
  if (composition.version !== 1 || composition.source !== compositionSource
    || typeof composition.breaker?.acquireCandidate !== "function"
    || typeof composition.breaker?.recordRetryableFailure !== "function"
    || typeof composition.breaker?.snapshot !== "function"
    || typeof composition.coordinator?.reconcileProjection !== "function"
    || typeof composition.coordinator?.createProjectionView !== "function"
    || typeof composition.coordinator?.snapshot !== "function") {
    throw new TypeError("Incompatible model health Host composition");
  }
  return composition;
}
const existing = processHost[compositionKey];
const composition = existing === undefined
  ? Object.freeze({ version: 1 as const, source: compositionSource,
    breaker: new ModelCircuitBreaker(), coordinator: new ModelHealthCoordinator() })
  : readComposition(existing);
if (existing === undefined) Object.defineProperty(processHost, compositionKey, { value: composition });
export const sharedModelCircuitBreaker = composition.breaker;
export const sharedModelHealthCoordinator = composition.coordinator;
