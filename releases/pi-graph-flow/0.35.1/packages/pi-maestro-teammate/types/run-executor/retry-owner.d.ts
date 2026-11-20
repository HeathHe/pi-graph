import type { SingleResult } from "../shared/types.ts";
import type { RunSingleTeammateParams, RunTeammateOptions } from "../runs/execution-infra.ts";
import type { ExecutionPorts } from "./lifecycle-contracts.ts";
import type { DispatchContext } from "./dispatch-owner.ts";
export declare function createRetryOwner(ports: ExecutionPorts & DispatchContext): {
    runSingleTeammate: (params: RunSingleTeammateParams, options: RunTeammateOptions) => Promise<SingleResult>;
    runSingleTeammateWithOrigin: (params: RunSingleTeammateParams, options: RunTeammateOptions, capturedBackendSource?: {
        readonly origin: object | undefined;
    }) => Promise<SingleResult>;
};
