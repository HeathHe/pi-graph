import type { SingleResult, AgentProgress, AgentTerminalStatus, TeammateExecutionProvenance } from "../shared/types.ts";
export * from "./execution-infra.ts";
import type { NormalizedTask, RunSingleTeammateParams, RunTeammateOptions, RunTeammateParams } from "./execution-infra.ts";
import type { AttemptOutcome, BackendCapabilities, BackendRun } from "pi-maestro-backend-core/v1/backend";
import type { TeammateRunSpec } from "pi-maestro-backend-core/v1/spec";
export { TOOL_EXECUTION_HEARTBEAT_MS, resolveAgentCacheRetention, hasRpcTurnSidecar, sendRpcMessage, sendRpcMessageWithReceipt, sendChildIpcMessage, dispatchChildIpcMessage, } from "./pi-subprocess-attempt.ts";
export type { RpcMessageMode, RpcInputDisposition, RpcReceipt } from "./pi-subprocess-attempt.ts";
export declare const runSingleTeammate: (params: RunSingleTeammateParams, options: RunTeammateOptions) => Promise<SingleResult>, runGraph: (tasks: NormalizedTask[], concurrency: number, options: RunTeammateOptions) => Promise<SingleResult[]>, runTeammate: (params: RunTeammateParams, options: RunTeammateOptions) => Promise<SingleResult[]>, normalizeGraphConcurrency: (concurrency: number, taskCount: number) => number, hostRegistryResultProvenance: (result: SingleResult) => TeammateExecutionProvenance | undefined, projectBackendProgress: (data: Record<string, unknown>, agent: string, startedAt: number) => AgentProgress, startFabricSourceBackendAttempt: (input: {
    placement: import("pi-maestro-fabric-core/v1").TeammatePlacementV1;
    spec: TeammateRunSpec;
    correlationId: string;
    baseCwd: string;
    signal: AbortSignal;
    onChildEvent?: (event: Record<string, unknown>) => void;
    onTurnComplete?: (result: SingleResult, terminalStatus?: AgentTerminalStatus) => void;
}, runtimeOptions?: import("../run-executor/dispatch-owner.ts").FabricSourceRuntimeOptions) => Promise<{
    acceptedBackend: string;
    acceptedModel?: string;
    acceptedCapabilities: BackendCapabilities;
    outcome: Promise<AttemptOutcome>;
    send: BackendRun["send"];
    abort: BackendRun["abort"];
}>;
