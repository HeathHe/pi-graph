import { resolveBackendConfig as resolveCoreConfig } from "pi-graph-provider-backend/config";
import type { ConfigValue, ResolvedBackendConfig, TeammateBackend } from "pi-maestro-backend-core/v1/backend";

/** Preserve the v1 surface while delegating configuration ownership to the core. */
export function resolveBackendConfig(
  backend: TeammateBackend,
  config: Record<string, ConfigValue> = {},
): ResolvedBackendConfig {
  return resolveCoreConfig(backend, config);
}
