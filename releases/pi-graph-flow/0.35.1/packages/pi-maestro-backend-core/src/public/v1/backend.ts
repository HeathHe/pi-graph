/** Compatibility v1 types; algorithms and generic contracts live in the provider-backend core. */
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { TeammateBackend as CoreTeammateBackend } from "pi-graph-provider-backend/protocol/backend";

export type {
  CapabilitySupport,
  BackendCapabilities,
  CapabilityName,
  RecoveryShape,
  SettlementAuthority,
  AttemptRecoveryFacts,
  AttemptReclamation,
  AttemptOutcome,
  ConfigValue,
  BackendConfigField,
  ResolvedBackendConfig,
  BackendHostCapabilities,
  BackendRunOptions,
  BackendRun,
  BackendConfigOption,
} from "pi-graph-provider-backend/protocol/backend";

export type TeammateBackend = CoreTeammateBackend<TeammatePlacementV1>;
