/**
 * The Pi subprocess attempt: everything needed to run one teammate turn in a
 * child Pi runtime, from spawn through settlement and child-process reclamation.
 *
 * Split out of `execution.ts` so orchestration and backend implementation stop
 * sharing a file. `execution.ts` keeps the model-candidate sweep, circuit
 * breaker, replay fence, and completion publication — decisions about *which*
 * model runs. This module owns what one specific runtime does with an
 * already-chosen model.
 *
 * The recovery WeakMaps are written here and read only by this package's Pi
 * backend adapter, which turns them into the contract's `AttemptOutcome`. They
 * are deliberately absent from the package's public surface: outside this pair
 * of modules, recovery facts travel as a value on the outcome rather than as a
 * side channel a caller can forget to consult.
 */
import { type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { type AgentConfig } from "../agents/agents.ts";
import { type ReplyTarget } from "../shared/routing.ts";
import type { SingleResult, MessageProvenanceV1 } from "../shared/types.ts";
import { type LeaseToken } from "./session-handoff.ts";
import type { RunSingleTeammateParams, RunTeammateOptions } from "./execution-infra.ts";
export type { AttemptSettlementCapability } from "../run-executor/attempt-owner.ts";
export type { RpcMessageMode, RpcInputDisposition, RpcReceipt } from "../run-executor/control-owner.ts";
export declare const attemptReclamations: WeakMap<SingleResult, Promise<unknown>>, attemptRecoveryFacts: WeakMap<SingleResult, import("../run-executor/attempt-owner.ts").AttemptRecoveryFacts>, TOOL_EXECUTION_HEARTBEAT_MS: number, resolveAgentCacheRetention: (env?: NodeJS.ProcessEnv) => string, runSingleAttempt: (params: RunSingleTeammateParams, agentConfig: AgentConfig, cwd: string, correlationId: string, replyTo: ReplyTarget, startTime: number, modelOverride: string | undefined, options: RunTeammateOptions, originalDispatch?: {
    readonly origin: object | undefined;
    readonly request: import("../public/v1/task-dispatch-binding.ts").TaskDispatchRequest;
}) => Promise<SingleResult>, isNativeDurabilityFailure: (result: SingleResult) => boolean, sendRpcMessageWithReceipt: (stdin: Writable, message: string, mode?: import("../run-executor/control-owner.ts").RpcMessageMode, token?: LeaseToken, provenance?: MessageProvenanceV1) => Promise<import("../run-executor/control-owner.ts").RpcReceipt>, hasRpcTurnSidecar: (stdin: Writable) => boolean, sendRpcMessage: (stdin: Writable, message: string, mode?: import("../run-executor/control-owner.ts").RpcMessageMode, token?: LeaseToken, provenance?: MessageProvenanceV1, requestId?: string) => boolean, sendChildIpcMessage: (child: ChildProcess, message: Record<string, unknown>) => boolean, dispatchChildIpcMessage: (message: Record<string, unknown>, onRequest: RunTeammateOptions["onChildRequest"], onEvent: RunTeammateOptions["onChildEvent"], reply: (message: unknown) => void) => "request" | "event";
