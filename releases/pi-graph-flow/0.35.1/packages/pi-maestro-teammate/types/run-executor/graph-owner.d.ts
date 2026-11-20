import type { SingleResult } from "../shared/types.ts";
import type { NormalizedTask, RunTeammateOptions } from "../runs/execution-infra.ts";
import type { ExecutionPorts } from "./lifecycle-contracts.ts";
import type { DispatchContext } from "./dispatch-owner.ts";
import type { createRetryOwner } from "./retry-owner.ts";
export declare function createGraphOwner(ports: ExecutionPorts & DispatchContext & ReturnType<typeof createRetryOwner>): {
    runGraph: (tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions) => Promise<SingleResult[]>;
    normalizeGraphConcurrency: (concurrency: number, taskCount: number) => number;
};
