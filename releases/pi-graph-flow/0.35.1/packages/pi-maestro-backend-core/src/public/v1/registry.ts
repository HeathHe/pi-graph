/** Compatibility v1 types; algorithms and generic contracts live in the provider-backend core. */
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { ResolvedBackend as CoreResolvedBackend } from "pi-graph-provider-backend/protocol/registry";
import type { BackendRegistry as CoreBackendRegistry } from "pi-graph-provider-backend/protocol/registry";

export type {
  TeammateExecutionMode,
  BackendRegistration,
  BackendRegistryConfig,
  RequiredCapabilities,
  DegradableCapability,
  CapabilityVerdict,
  CapabilityValidation,
} from "pi-graph-provider-backend/protocol/registry";

export type ResolvedBackend = CoreResolvedBackend<TeammatePlacementV1>;

export type BackendRegistry = CoreBackendRegistry<TeammatePlacementV1>;
