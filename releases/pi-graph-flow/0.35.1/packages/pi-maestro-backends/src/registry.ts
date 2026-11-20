import { TeammateBackendRegistry as CoreBackendRegistry, type BackendLoader } from "pi-graph-provider-backend/registry";
import type { BackendRegistryConfig } from "pi-maestro-backend-core/v1/registry";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";

export type { BackendLoader } from "pi-graph-provider-backend/registry";

/** Host compatibility seam: dynamic imports remain outside the pure core. */
export class TeammateBackendRegistry extends CoreBackendRegistry<TeammatePlacementV1> {
  constructor(config: BackendRegistryConfig, load: BackendLoader = module => import(module)) {
    super(config, load);
  }
}
