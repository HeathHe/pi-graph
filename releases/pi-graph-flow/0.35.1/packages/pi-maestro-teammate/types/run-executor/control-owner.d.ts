import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { MessageProvenanceV1 } from "../shared/types.ts";
import type { LeaseToken } from "../runs/session-handoff.ts";
import type { JsonLineEvent, RunTeammateOptions } from "../runs/execution-infra.ts";
import type { AttemptPorts } from "./lifecycle-contracts.ts";
export interface TransportSidecarLease {
    commit(): void;
    cancel(): void;
}
export interface TransportSidecar {
    enqueue(transportMessage: string, acceptedMessage: string, mode: "prompt" | "steer" | "follow_up", provenance?: MessageProvenanceV1, requestId?: string): TransportSidecarLease;
}
export type RpcMessageMode = "prompt" | "steer" | "follow_up" | "abort" | "interrupt";
export type RpcInputDisposition = "handled" | "queued" | "started" | "legacy-accepted" | "transport-written" | "interrupt-requested";
export type RpcReceipt = {
    accepted: boolean;
    disposition?: RpcInputDisposition;
    error?: string;
};
export type InterruptHandler = (message: string, token?: LeaseToken, provenance?: MessageProvenanceV1) => boolean;
export declare function createControlOwner(ports: AttemptPorts): {
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
};
