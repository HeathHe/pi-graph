import {
  requiredCapabilities as requiredCoreCapabilities,
  adjudicateTask as adjudicateCoreTask,
  validateBackendCapabilities as validateCoreCapabilities,
  type AdjudicatedTask as CoreAdjudicatedTask,
} from "pi-graph-provider-backend/capabilities";
import type { BackendCapabilities, CapabilityName } from "pi-maestro-backend-core/v1/backend";
import type { CapabilityValidation, CapabilityVerdict } from "pi-maestro-backend-core/v1/registry";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";

export type AdjudicatedTask = CoreAdjudicatedTask<TeammatePlacementV1>;

export function requiredCapabilities(task: AdjudicatedTask): CapabilityName[] {
  return requiredCoreCapabilities(task);
}

export function adjudicateTask(
  task: AdjudicatedTask,
  taskIndex: number,
  backendName: string,
  capabilities: BackendCapabilities,
): CapabilityVerdict {
  return adjudicateCoreTask(task, taskIndex, backendName, capabilities);
}

export function validateBackendCapabilities(
  tasks: readonly AdjudicatedTask[],
  backendOf: (task: AdjudicatedTask, index: number) => { name: string; capabilities: BackendCapabilities },
): CapabilityValidation {
  return validateCoreCapabilities(tasks, backendOf);
}
