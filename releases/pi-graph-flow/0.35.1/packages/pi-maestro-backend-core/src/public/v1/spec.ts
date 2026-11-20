/** Compatibility v1 types; algorithms and generic contracts live in the provider-backend core. */
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { TeammateRunSpec as CoreTeammateRunSpec } from "pi-graph-provider-backend/protocol/spec";

export type {
  Usage,
  AgentTerminalStatus,
  ThinkingLevel,
  RunContext,
  CapabilityDelivery,
  TeammateExecutionTransport,
  TeammateExecutionProvenance,
  SingleResult,
  ControlMode,
} from "pi-graph-provider-backend/protocol/spec";

export type TeammateRunSpec = CoreTeammateRunSpec<TeammatePlacementV1>;
