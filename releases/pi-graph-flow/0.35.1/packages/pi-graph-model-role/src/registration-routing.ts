import type { DispatchAuthorityProjection } from './model-registry.ts';
import type { ModelRegistrationRoutingInput, ResolvedModelRegistrationCandidate, ResolvedModelRegistrationRouting } from './routing-types.ts';
export function canonicalModelRegistrationId(
  projection: DispatchAuthorityProjection,
  requested: string,
): string {
  const canonical = projection.modelAliases.get(requested) ?? requested;
  if (!projection.routesByRegistrationId.has(canonical)) {
    throw new TypeError(
      `Unknown teammate model registration ${JSON.stringify(requested)}. Use an available canonical registration id or configured model alias.`,
    );
  }
  return canonical;
}

export function canonicalDeploymentId(
  projection: DispatchAuthorityProjection,
  requested: string,
): string {
  const canonical = projection.backendAliases.get(requested) ?? requested;
  if (!projection.deploymentsById.has(canonical)) {
    throw new TypeError(
      `Unknown teammate deployment ${JSON.stringify(requested)}. Use a registered deployment id or configured backend alias.`,
    );
  }
  return canonical;
}

export function deploymentDefaultRegistrationId(
  projection: DispatchAuthorityProjection,
  deploymentId: string,
): string {
  for (const [registrationId, route] of projection.routesByRegistrationId) {
    if (route.deploymentId === deploymentId && route.deploymentDefault) return registrationId;
  }
  throw new TypeError(
    `Teammate deployment ${JSON.stringify(deploymentId)} has no model registration marked deploymentDefault.`,
  );
}

export function registrationCandidate(
  projection: DispatchAuthorityProjection,
  modelRegistrationId: string,
): ResolvedModelRegistrationCandidate {
  const route = projection.routesByRegistrationId.get(modelRegistrationId);
  if (route === undefined) {
    throw new TypeError(`Unknown canonical teammate model registration ${JSON.stringify(modelRegistrationId)}.`);
  }
  const deployment = projection.deploymentsById.get(route.deploymentId);
  if (deployment === undefined) {
    throw new TypeError(
      `Teammate model registration ${JSON.stringify(modelRegistrationId)} targets unknown deployment ${JSON.stringify(route.deploymentId)}.`,
    );
  }
  return Object.freeze({ modelRegistrationId, route, deployment });
}

/**
 * Resolve one registry-mode task entirely through the captured dispatch
 * authority. No adapter model id, backend heuristic, or remote target name is
 * treated as a registration implicitly.
 */
export function resolveModelRegistrationRouting(
  projection: DispatchAuthorityProjection,
  input: ModelRegistrationRoutingInput,
): ResolvedModelRegistrationRouting {
  const requestedDeploymentId = input.backend === undefined
    ? undefined
    : canonicalDeploymentId(projection, input.backend);
  const remoteLocation = input.cwd?.startsWith("remote:") === true ? input.cwd : undefined;
  const remoteRegistrationId = remoteLocation === undefined
    ? undefined
    : projection.remoteLocations.get(remoteLocation);

  if (remoteLocation !== undefined && remoteRegistrationId === undefined) {
    throw new TypeError(
      `Unknown model-registry remote location ${JSON.stringify(remoteLocation)}. Configure an explicit remoteLocations registration mapping.`,
    );
  }

  const explicitPrimary = input.model === undefined
    ? undefined
    : canonicalModelRegistrationId(projection, input.model);
  const primary = explicitPrimary
    ?? remoteRegistrationId
    ?? (requestedDeploymentId === undefined
      ? projection.defaultModel
      : deploymentDefaultRegistrationId(projection, requestedDeploymentId));
  const canonicalFallbacks = (input.fallbackModels ?? []).map((model) =>
    canonicalModelRegistrationId(projection, model));
  const candidateIds = [...new Set([primary, ...canonicalFallbacks])];
  const candidates = candidateIds.map((registrationId) => registrationCandidate(projection, registrationId));

  if (remoteRegistrationId !== undefined) {
    const remote = registrationCandidate(projection, remoteRegistrationId);
    if (remote.deployment.runtime.transport.kind !== "remote-worker") {
      throw new TypeError(
        `Model-registry remote location ${JSON.stringify(remoteLocation)} maps to non-remote model registration ${JSON.stringify(remoteRegistrationId)}.`,
      );
    }
    const conflict = candidates.find((candidate) => candidate.modelRegistrationId !== remoteRegistrationId);
    if (conflict !== undefined) {
      throw new TypeError(
        `Teammate model registration ${JSON.stringify(conflict.modelRegistrationId)} conflicts with remote location ${JSON.stringify(remoteLocation)}, which selects ${JSON.stringify(remoteRegistrationId)}.`,
      );
    }
  }

  if (requestedDeploymentId !== undefined) {
    const conflict = candidates.find((candidate) => candidate.route.deploymentId !== requestedDeploymentId);
    if (conflict !== undefined) {
      throw new TypeError(
        `Teammate model registration ${JSON.stringify(conflict.modelRegistrationId)} targets deployment ${JSON.stringify(conflict.route.deploymentId)}, which conflicts with requested deployment ${JSON.stringify(requestedDeploymentId)}.`,
      );
    }
  }

  return Object.freeze({
    candidates: Object.freeze(candidates),
    ...(requestedDeploymentId === undefined ? {} : { requestedDeploymentId }),
    ...(remoteLocation === undefined ? {} : { remoteLocation }),
  });
}

/** Pi can hot-switch only between adapter selectors owned by one Pi deployment. */
export function canHotSwitchModelRegistration(
  from: ResolvedModelRegistrationCandidate,
  to: ResolvedModelRegistrationCandidate,
): boolean {
  return from.route.deploymentId === to.route.deploymentId
    && from.deployment.runtime.harness === "pi"
    && to.deployment.runtime.harness === "pi"
    && from.route.selector.kind === "adapter-model"
    && to.route.selector.kind === "adapter-model";
}
