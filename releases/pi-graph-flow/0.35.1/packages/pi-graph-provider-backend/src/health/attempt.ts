import type { ModelHealthScope, ModelHealthTarget } from "./circuit.ts";
export type HealthRetryKind = "network" | "provider" | "fallback-only" | "auth" | "non-retryable";
export type ModelHealthFailureScope = ModelHealthScope | "none";

export interface ModelHealthFailureInput {
  message?: string;
  status?: number;
  /** Authoritative backend-aware override when the text cannot identify ownership. */
  scope?: ModelHealthFailureScope;
}

export interface ModelHealthFailureFacts extends ModelHealthFailureInput {
  retryKind: HealthRetryKind;
}

export interface ModelHealthFailureClassification {
  retryKind: HealthRetryKind;
  scope: ModelHealthFailureScope;
  affectsCircuit: boolean;
  suppressAuth: boolean;
}

/** Optional backend hook for assigning a failure to deployment or route health. */
export type ModelHealthFailureScopeClassifier = (
  failure: Readonly<ModelHealthFailureFacts>,
) => ModelHealthFailureScope | undefined;

export interface ModelHealthAttemptSnapshot {
  projectionFingerprint?: string;
  quarantinedDeployments: readonly string[];
  authSuppressions: readonly string[];
}

function defaultModelHealthFailureScope(retryKind: HealthRetryKind): ModelHealthFailureScope {
  if (retryKind === "network" || retryKind === "auth") return "deployment";
  if (retryKind === "provider" || retryKind === "fallback-only") return "route";
  return "none";
}

export function projectModelHealthFailure(retryKind: HealthRetryKind, explicitScope?: ModelHealthFailureScope): ModelHealthFailureClassification {
  const scope = explicitScope ?? defaultModelHealthFailureScope(retryKind);
  return Object.freeze({ retryKind, scope,
    affectsCircuit: scope !== "none" && retryKind !== "non-retryable",
    suppressAuth: retryKind === "auth" && scope !== "none" });
}

/** Collision-safe key for an attempt-local, scope-specific auth suppression. */
export function modelHealthAuthSuppressionKey(
  scope: ModelHealthScope,
  target: ModelHealthTarget,
): string {
  const value = scope === "deployment" ? target.deploymentId : target.modelRegistrationId;
  if (!value) throw new TypeError(`Model health ${scope} key must not be empty`);
  return `${scope}:${new TextEncoder().encode(value).byteLength}:${value}`;
}

export function isModelHealthAuthSuppressed(
  suppressions: ReadonlySet<string>,
  target: ModelHealthTarget,
): boolean {
  return suppressions.has(modelHealthAuthSuppressionKey("deployment", target))
    || suppressions.has(modelHealthAuthSuppressionKey("route", target));
}

/** Candidate-sweep state; never survives the attempt that created it. */
export class ModelHealthAttemptState {
  private fingerprint: string | undefined;
  private readonly quarantinedDeployments = new Set<string>();
  private readonly authSuppressions = new Set<string>();

  constructor(projectionFingerprint?: string) {
    this.fingerprint = projectionFingerprint;
  }

  get projectionFingerprint(): string | undefined {
    return this.fingerprint;
  }

  /** Clear attempt-local decisions when a new registry projection is observed. */
  reconcileProjectionFingerprint(projectionFingerprint: string): boolean {
    if (!projectionFingerprint) throw new TypeError("Model health projection fingerprint must not be empty");
    if (projectionFingerprint === this.fingerprint) return false;
    this.fingerprint = projectionFingerprint;
    this.quarantinedDeployments.clear();
    this.authSuppressions.clear();
    return true;
  }

  quarantineDeployment(deploymentId: string): void {
    if (!deploymentId) throw new TypeError("Model health deployment id must not be empty");
    this.quarantinedDeployments.add(deploymentId);
  }

  isDeploymentQuarantined(deploymentId: string): boolean {
    return this.quarantinedDeployments.has(deploymentId);
  }

  suppressAuth(scope: ModelHealthScope, target: ModelHealthTarget): void {
    this.authSuppressions.add(modelHealthAuthSuppressionKey(scope, target));
  }

  isAuthSuppressed(target: ModelHealthTarget): boolean {
    return isModelHealthAuthSuppressed(this.authSuppressions, target);
  }

  shouldSkip(target: ModelHealthTarget): boolean {
    return this.isDeploymentQuarantined(target.deploymentId) || this.isAuthSuppressed(target);
  }

  noteFailure(target: ModelHealthTarget, failure: ModelHealthFailureClassification): void {
    if (failure.scope === "deployment") this.quarantineDeployment(target.deploymentId);
    if (failure.suppressAuth && failure.scope !== "none") this.suppressAuth(failure.scope, target);
  }

  snapshot(): ModelHealthAttemptSnapshot {
    return Object.freeze({
      ...(this.fingerprint === undefined ? {} : { projectionFingerprint: this.fingerprint }),
      quarantinedDeployments: Object.freeze([...this.quarantinedDeployments].sort()),
      authSuppressions: Object.freeze([...this.authSuppressions].sort()),
    });
  }
}

