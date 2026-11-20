import { ModelCircuitBreaker, type ModelCircuitSnapshot, type ModelHealthTarget, type ModelHealthProjection, type ModelHealthCoordinatorOptions, type ModelHealthCandidateAcquisition, type AcquiredModelHealthCandidate, type ModelHealthScope, type ModelHealthSnapshot } from "./circuit.ts";

function scopedHealthRank(snapshot: ModelCircuitSnapshot | undefined): readonly [number, number] {
  if (!snapshot) return [0, 0];
  const band = snapshot.state === "OPEN" ? 2 : snapshot.state === "HALF_OPEN" ? 1 : 0;
  return [band, snapshot.consecutiveFailures];
}

function compareCompositeHealth(
  left: ModelHealthTarget,
  right: ModelHealthTarget,
  deploymentSnapshots: ReadonlyMap<string, ModelCircuitSnapshot>,
  routeSnapshots: ReadonlyMap<string, ModelCircuitSnapshot>,
): number {
  const leftDeployment = scopedHealthRank(deploymentSnapshots.get(left.deploymentId));
  const leftRoute = scopedHealthRank(routeSnapshots.get(left.modelRegistrationId));
  const rightDeployment = scopedHealthRank(deploymentSnapshots.get(right.deploymentId));
  const rightRoute = scopedHealthRank(routeSnapshots.get(right.modelRegistrationId));
  const leftRank = [
    Math.max(leftDeployment[0], leftRoute[0]),
    leftDeployment[0] + leftRoute[0],
    leftDeployment[1] + leftRoute[1],
  ];
  const rightRank = [
    Math.max(rightDeployment[0], rightRoute[0]),
    rightDeployment[0] + rightRoute[0],
    rightDeployment[1] + rightRoute[1],
  ];
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index]! - rightRank[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Registry-mode health authority. Deployment failures suppress every route on
 * that deployment, while route failures remain isolated to the canonical
 * model registration (aliases resolve to that same key).
 */
export class ModelHealthCoordinator {
  readonly deploymentBreaker: ModelCircuitBreaker;
  readonly routeBreaker: ModelCircuitBreaker;

  private projectionHash: string | undefined;
  private targets = new Map<string, ModelHealthTarget>();
  private aliases = new Map<string, string>();
  private reconcilesBreakerNamespace = true;

  constructor(options: ModelHealthCoordinatorOptions = {}) {
    if (options.deploymentBreaker && options.deployment) {
      throw new TypeError("Provide either deploymentBreaker or deployment options, not both");
    }
    if (options.routeBreaker && options.route) {
      throw new TypeError("Provide either routeBreaker or route options, not both");
    }
    if (options.deploymentBreaker !== undefined && options.deploymentBreaker === options.routeBreaker) {
      throw new TypeError("Deployment and route health require separate breaker instances");
    }
    this.deploymentBreaker = options.deploymentBreaker ?? new ModelCircuitBreaker(options.deployment);
    this.routeBreaker = options.routeBreaker ?? new ModelCircuitBreaker(options.route);
  }

  get projectionFingerprint(): string | undefined {
    return this.projectionHash;
  }

  /**
   * Capture one projection's target namespace while sharing this coordinator's
   * process-wide breaker stores. Catalog refreshes can then reconcile their own
   * maps without changing how an admitted dispatch resolves canonical ids.
   */
  createProjectionView(projection: ModelHealthProjection): ModelHealthCoordinator {
    const view = new ModelHealthCoordinator({
      deploymentBreaker: this.deploymentBreaker,
      routeBreaker: this.routeBreaker,
    });
    // Namespace reclamation belongs to the process-wide coordinator. A pinned
    // dispatch may outlive a catalog refresh and must never prune newer keys.
    view.reconcilesBreakerNamespace = false;
    view.reconcileProjection(projection);
    return view;
  }

  /**
   * Reconcile keys only when the authoritative projection fingerprint moves.
   * Health for still-present canonical ids survives a refresh; removed ids are
   * forgotten so deleting and later re-adding a registration starts healthy.
   */
  reconcileProjection(projection: ModelHealthProjection): boolean {
    if (!projection.hash) throw new TypeError("Model health projection hash must not be empty");
    if (projection.hash === this.projectionHash) return false;

    const nextTargets = new Map<string, ModelHealthTarget>();
    for (const [registrationId, route] of projection.routesByRegistrationId) {
      if (!registrationId || !route.deploymentId || route.modelRegistrationId !== registrationId) {
        throw new TypeError(`Invalid model health route projection for "${registrationId}"`);
      }
      if (!projection.deploymentsById.has(route.deploymentId)) {
        throw new TypeError(`Model health route "${registrationId}" references unknown deployment "${route.deploymentId}"`);
      }
      nextTargets.set(registrationId, Object.freeze({
        deploymentId: route.deploymentId,
        modelRegistrationId: registrationId,
      }));
    }

    const nextAliases = new Map<string, string>();
    for (const [alias, target] of projection.modelAliases) {
      if (!alias || !nextTargets.has(target)) {
        throw new TypeError(`Invalid model health alias "${alias}" -> "${target}"`);
      }
      nextAliases.set(alias, target);
    }

    if (this.reconcilesBreakerNamespace) {
      const deployments = new Set(projection.deploymentsById.keys());
      for (const snapshot of this.deploymentBreaker.snapshot()) {
        if (!deployments.has(snapshot.model)) this.deploymentBreaker.forget(snapshot.model);
      }
      for (const snapshot of this.routeBreaker.snapshot()) {
        if (!nextTargets.has(snapshot.model)) this.routeBreaker.forget(snapshot.model);
      }
    }
    this.targets = nextTargets;
    this.aliases = nextAliases;
    this.projectionHash = projection.hash;
    return true;
  }

  resolveTarget(modelRegistrationId: string): ModelHealthTarget | undefined {
    if (!modelRegistrationId) throw new TypeError("Model registration id must not be empty");
    const canonical = this.aliases.get(modelRegistrationId) ?? modelRegistrationId;
    return this.targets.get(canonical);
  }

  /** Read-only composite availability; absent circuit history is healthy. */
  isHealthy(modelRegistrationId: string): boolean {
    const target = this.resolveTarget(modelRegistrationId);
    if (!target) return true;
    const deployment = this.deploymentBreaker.snapshot().find((entry) => entry.model === target.deploymentId);
    const route = this.routeBreaker.snapshot().find((entry) => entry.model === target.modelRegistrationId);
    return (deployment === undefined || deployment.state === "CLOSED")
      && (route === undefined || route.state === "CLOSED");
  }

  acquireCandidate(modelRegistrationId: string): ModelHealthCandidateAcquisition {
    const target = this.resolveTarget(modelRegistrationId);
    if (!target) throw new TypeError(`Unknown model registration "${modelRegistrationId}"`);

    const deployment = this.deploymentBreaker.acquireCandidate(target.deploymentId);
    if (!deployment.allowed) {
      return { allowed: false, target, blockedScope: "deployment", circuit: deployment };
    }

    const route = this.routeBreaker.acquireCandidate(target.modelRegistrationId);
    if (!route.allowed) {
      // The paired permit is atomic from the caller's point of view. Returning
      // the deployment's unspent trial prevents a hidden HALF_OPEN holder.
      this.deploymentBreaker.cancelCandidate(deployment);
      return { allowed: false, target, blockedScope: "route", circuit: route };
    }
    return { allowed: true, target, deployment, route };
  }

  recordSuccess(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.recordSuccess(acquisition.deployment);
    this.routeBreaker.recordSuccess(acquisition.route);
  }

  /** Charge only the failed scope and conclusively settle the paired permit. */
  recordFailure(acquisition: AcquiredModelHealthCandidate, scope: ModelHealthScope): void {
    if (scope === "deployment") {
      this.deploymentBreaker.recordRetryableFailure(acquisition.deployment);
      this.routeBreaker.cancelCandidate(acquisition.route);
      return;
    }
    this.deploymentBreaker.recordSuccess(acquisition.deployment);
    this.routeBreaker.recordRetryableFailure(acquisition.route);
  }

  /** Settle an inconclusive attempt using the legacy fresh-cooldown release rule. */
  releaseCandidate(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.releaseCandidate(acquisition.deployment);
    this.routeBreaker.releaseCandidate(acquisition.route);
  }

  /** Return both permits without charging either scope or extending cooldown. */
  cancelCandidate(acquisition: AcquiredModelHealthCandidate): void {
    this.deploymentBreaker.cancelCandidate(acquisition.deployment);
    this.routeBreaker.cancelCandidate(acquisition.route);
  }

  rankCandidates(modelRegistrationIds: readonly string[]): string[] {
    const deploymentSnapshots = new Map(this.deploymentBreaker.snapshot().map((entry) => [entry.model, entry]));
    const routeSnapshots = new Map(this.routeBreaker.snapshot().map((entry) => [entry.model, entry]));
    return [...modelRegistrationIds].sort((left, right) => {
      const leftTarget = this.resolveTarget(left);
      const rightTarget = this.resolveTarget(right);
      if (!leftTarget) return rightTarget ? 1 : 0;
      if (!rightTarget) return -1;
      return compareCompositeHealth(leftTarget, rightTarget, deploymentSnapshots, routeSnapshots);
    });
  }

  snapshot(): ModelHealthSnapshot {
    return Object.freeze({
      ...(this.projectionHash === undefined ? {} : { projectionFingerprint: this.projectionHash }),
      deployments: this.deploymentBreaker.snapshot(),
      routes: this.routeBreaker.snapshot(),
    });
  }
}

export function rankModelRegistrationsByHealth(
  modelRegistrationIds: readonly string[],
  health: ModelHealthCoordinator,
): string[] {
  return health.rankCandidates(modelRegistrationIds);
}
