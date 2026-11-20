import type { TaskDispatchRequest } from "../public/v1/task-dispatch-binding.ts";
import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { AgentConfig } from "../agents/agents.ts";
import type { ReplyTarget } from "../shared/routing.ts";
import type { SingleResult, AgentTurnMessageMetadataV1, AgentTurnTriggerContextV1, MessageProvenanceV1 } from "../shared/types.ts";
import type { LeaseToken } from "../runs/session-handoff.ts";
import type { ReplayEvidenceCollector, RecoveryFailureChainV1, RecoveryWakeReceiptV1 } from "../runs/recovery-protocol.ts";
import type { JsonLineEvent, RunSingleTeammateParams, RunTeammateOptions, StructuredOutputCandidate } from "../runs/execution-infra.ts";
import type { AttemptPorts, AttemptAssets } from "./lifecycle-contracts.ts";
import type { TransportSidecar, RpcMessageMode, RpcReceipt, InterruptHandler } from "./control-owner.ts";
export interface AttemptRecoveryFacts {
    settlementCapability: AttemptSettlementCapability;
    completedToolCount: number;
    inFlightToolCount: number;
    /** A non-zero close before any child event, stderr, or possible side effect. */
    preActivityInfrastructureExit: boolean;
    /** Exact compatibility projection of replayEvidence. */
    externalReplayRisk: boolean;
    replayEvidence?: ReturnType<ReplayEvidenceCollector["snapshot"]>;
    /** Non-JSON stdout was attributed as assistant content (protocol violation). Optional: not all settlement paths populate it. */
    stdoutProtocolViolation?: boolean;
}
export interface AttemptSessionContext {
    /** Private per-correlation session directory, when the parent exposes one. */
    sessionDir?: string;
    /** Existing child session loaded after a cold runtime restart. */
    resumeSessionFile?: string;
    /** Parent session file the child forks from. */
    forkSessionFile?: string;
    /** Transcript note emitted when an explicit fork could not be honoured. */
    forkWarning?: string;
}
export interface AttemptState {
    nativeRecoveryFailure?: string;
    lastContent: string;
    streamingText: string;
    stderrBuffer: string;
    pendingStructuredOutput?: StructuredOutputCandidate;
    capturedStructuredOutput: unknown;
    structuredOutputValidationFailure?: string;
    /** Set when the child's structured_output tool execution itself failed. */
    structuredOutputAttemptFailed: boolean;
    structuredOutputSubmissionConfirmed: boolean;
    reportedRuntimeErrors: Set<string>;
    runtimeFailure?: string;
    modelSwitchFailure?: {
        diagnostic: string;
        source: "provider" | "transport";
    };
    /**
     * progress.toolCount stays cumulative for the lifetime of a wakeable agent so
     * it reads on the same scale as the cumulative token counters. This per-turn
     * count only feeds diagnostics.
     */
    turnToolCount: number;
    /**
     * Re-opened at every turn boundary, set by completeTurn(). Guards against a
     * second settlement for the same turn.
     */
    turnLifecycleSettled: boolean;
    /** Last assistant stop reason observed for this turn. */
    lastAssistantStopReason?: string;
    /** A length-truncated turn is waiting for child-local compaction and continuation. */
    outputLimitRecoveryPending: boolean;
    /** A Flow synthetic compaction interruption must continue before this turn can settle. */
    compactionWakeProtocolCapable: boolean;
    latestWakeReceipt?: RecoveryWakeReceiptV1;
    compactionRecovery?: {
        recoveryId: string;
        producer: string;
        generation: number;
        phase: "pending" | "continuation" | "completed";
        wakeProtocolVersion?: 1;
        wakeId?: string;
        wakeReceipt?: RecoveryWakeReceiptV1;
        absoluteDeadlineAt?: number;
    };
    resolvedModel: string;
    /**
     * Result usage remains turn-scoped, while status usage stays cumulative for
     * the lifetime of a wakeable agent.
     */
    completedInputTokens: number;
    completedOutputTokens: number;
    completedCacheReadTokens: number;
    completedCacheWriteTokens: number;
    /** One-way latches; never reset. */
    receivedFirstActivity: boolean;
    /** True only for a silent non-zero close before any child event or possible effect. */
    preActivityInfrastructureExit: boolean;
    /** Bounded monotonic provenance; the public boolean is its exact projection. */
    replayEvidence: ReplayEvidenceCollector;
    /** Non-JSON stdout was attributed as assistant content (protocol violation). */
    stdoutProtocolViolation: boolean;
    initialResultPublished: boolean;
    /** Recovery evidence used to fence any fresh-process model fallback. */
    settlementCapability: AttemptSettlementCapability;
    completedToolCount: number;
    inFlightToolCount: number;
    failureSequence: number;
    failureChain: RecoveryFailureChainV1;
    /** Absorbing state: once terminal, queued child lines must not reopen a turn. */
    terminal: boolean;
    /** Unique owner of an asynchronous model-selection decision. */
    modelSwitchDecisionId?: string;
    /** In-process model switch transaction, when one is awaiting Pi's ack. */
    modelSwitch?: {
        requestId: string;
        targetModel: string;
        /** False until Pi confirms the `set_model` command. */
        acknowledged: boolean;
    };
    /**
     * Model currently active after an in-process switch (undefined until the
     * first switch is acknowledged). Passed back to `onModelFailover` so the
     * decision hook can settle the previous trial and avoid re-selecting it.
     */
    switchedModel?: string;
    /**
     * Request id of the resume prompt issued after a successful in-process
     * model switch. A rejected response for this id must settle the turn (the
     * child is alive but refuses to continue, so no other settlement path
     * exists).
     */
    modelSwitchResumeRequestId?: string;
}
export interface AttemptTimers {
    firstActivity?: ReturnType<typeof setTimeout>;
    compactionIpcDrain?: ReturnType<typeof setImmediate>;
    resultReadyGrace?: ReturnType<typeof setTimeout>;
    outputLimitRecovery?: ReturnType<typeof setTimeout>;
    compactionRecovery?: ReturnType<typeof setTimeout>;
    interruptingSteer?: ReturnType<typeof setTimeout>;
    toolHeartbeat?: ReturnType<typeof setInterval>;
    modelSwitch?: ReturnType<typeof setTimeout>;
}
export interface PendingInterrupt {
    abortRequestId: string;
    promptRequestId: string;
    message: string;
    token?: LeaseToken;
    provenance?: MessageProvenanceV1;
    phase: "aborting" | "prompting";
    /** Set when the interrupted turn settles; a later turn_start means the steer missed its window. */
    turnSettledDuringAbort?: boolean;
}
export interface PendingModelInput {
    requestId: string;
    /** Exact leased string written on the Pi transport. */
    transportMessage: string;
    /** Exact user text after the child input hook validates and unwraps the lease. */
    acceptedMessage: string;
    context: AgentTurnTriggerContextV1;
    loopSeq: number;
    eventsEmitted: boolean;
    initial: boolean;
    committed: boolean;
    nativeInputGeneration?: number;
    nativeTurnEpoch?: number;
    lastMessage?: AgentTurnMessageMetadataV1;
}
export interface ChildCompactionCapability {
    type: "teammate_compaction_capability";
    runtimeGeneration: number;
}
export interface ChildCompactionStateEvent {
    type: "teammate_compaction_state";
    recoveryId: string;
    /** Producer-local generations are comparable only within this namespace. */
    producer: string;
    generation: number;
    phase: "pending" | "continuation" | "completed" | "failed" | "cancelled";
    /** Capability advertisement is carried on the ordered IPC state channel. */
    wakeProtocolVersion?: 1;
    wakeId?: string;
    wakeDeadlineAt?: number;
    reason?: string;
}
export type AttemptSettlementCapability = "agent_settled" | "legacy" | "unknown";
export declare function createAttemptOwner(ports: AttemptPorts, assets: AttemptAssets): {
    guardedChildStdinStreams: WeakSet<Writable>;
    nativeWriteGates: WeakMap<Writable, {
        handle: object | undefined;
        control: () => void;
        failed?: (error: unknown) => void;
    }>;
    nativeWriteFailures: WeakMap<Writable, Error>;
    interruptHandlers: WeakMap<Writable, InterruptHandler>;
    transportSidecars: WeakMap<Writable, TransportSidecar>;
    nativeRpcStreams: WeakSet<Writable>;
    rpcResponses: WeakMap<Writable, Map<string, {
        command: string;
        finish: (receipt: RpcReceipt) => void;
    }>>;
    acceptRpcResponse: (stdin: Writable, event: JsonLineEvent) => void;
    rejectRpcResponses: (stdin: Writable) => void;
    sendRpcMessageWithReceipt: (stdin: Writable, message: string, mode?: RpcMessageMode, token?: LeaseToken, provenance?: MessageProvenanceV1) => Promise<RpcReceipt>;
    guardChildStdin: (stdin: Writable) => void;
    writeChildStdinLine: (stdin: Writable, line: string) => boolean;
    writeTransportModelInput: (stdin: Writable, envelope: Record<string, unknown>, transportMessage: string, acceptedMessage: string, mode: "prompt" | "steer" | "follow_up", provenance?: MessageProvenanceV1) => boolean;
    hasRpcTurnSidecar: (stdin: Writable) => boolean;
    sendRpcMessage: (stdin: Writable, message: string, mode?: RpcMessageMode, token?: LeaseToken, provenance?: MessageProvenanceV1, requestId?: string) => boolean;
    sendChildIpcMessage: (child: ChildProcess, message: Record<string, unknown>) => boolean;
    dispatchChildIpcMessage: (message: Record<string, unknown>, onRequest: RunTeammateOptions["onChildRequest"], onEvent: RunTeammateOptions["onChildEvent"], reply: (message: unknown) => void) => "request" | "event";
    replyFailedChildRequest: (message: Record<string, unknown>, reply: (message: unknown) => void, reason?: string) => void;
    attemptReclamations: WeakMap<SingleResult, Promise<unknown>>;
    attemptRecoveryFacts: WeakMap<SingleResult, AttemptRecoveryFacts>;
    TOOL_EXECUTION_HEARTBEAT_MS: number;
    resolveAgentCacheRetention: (env?: NodeJS.ProcessEnv) => string;
    runSingleAttempt: (params: RunSingleTeammateParams, agentConfig: AgentConfig, cwd: string, correlationId: string, replyTo: ReplyTarget, startTime: number, modelOverride: string | undefined, options: RunTeammateOptions, originalDispatch?: {
        readonly origin: object | undefined;
        readonly request: TaskDispatchRequest;
    }) => Promise<SingleResult>;
    isNativeDurabilityFailure: (result: SingleResult) => boolean;
};
