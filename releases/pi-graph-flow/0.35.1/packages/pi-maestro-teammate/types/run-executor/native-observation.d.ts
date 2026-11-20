import { ChildProcess } from "node:child_process";
export interface NativeResultObservation {
    readonly exitCode: number;
    readonly lifecyclePending: boolean;
    readonly wakeable: boolean;
    readonly terminalStatus?: string;
    /** Logical transport reference, NOT an HTTP request-attempt identity. */
    readonly turnReference?: Readonly<{
        requestId: string;
        loopSeq: number;
    }>;
}
export interface NativeCurrentTurnObservation {
    /** Invalidated by new input/loop activity, independently of published result history. */
    readonly epoch: number;
    readonly state: "unknown" | "queued" | "running" | "settled";
    /** Includes prepared inputs before the write has returned. */
    readonly queuedInputs: number;
    /** Host-local input generation, not a provider/model request-attempt identity. */
    readonly inputGeneration?: number;
    readonly requestId?: string;
    readonly loopSeq?: number;
    /** Matching real idle + non-pending result, not Task/Goal acceptance or success. */
    readonly settledEpoch?: number;
}
export interface NativeInputReference {
    readonly inputGeneration: number;
    readonly requestId: string;
    readonly loopSeq: number;
}
export interface NativeExecutionSnapshot {
    readonly namespace: "pi-graph-next:native-execution/1";
    readonly nativeInvocationId: string;
    readonly correlationId: string;
    readonly runtimeGeneration: number | null;
    readonly requestedTodoIds: readonly string[];
    readonly taskBinding: "unverified";
    readonly wholeAgentAttempt: "unknown";
    readonly actualModel: "unknown";
    readonly sequence: number;
    readonly process: Readonly<{
        processInstanceId?: string;
        pid?: number;
        startObserved: boolean;
        exit?: Readonly<{
            code: number | null;
            signal: string | null;
        }>;
        close?: Readonly<{
            code: number | null;
            signal: string | null;
        }>;
        errorObserved: boolean;
        reclamation: "unknown";
    }>;
    readonly currentTurn: NativeCurrentTurnObservation;
    readonly resultCount: number;
    /** Audit history; use currentTurn to determine whether this still describes current work. */
    readonly lastResult?: NativeResultObservation;
}
export interface NativeExecutionIdentity {
    readonly correlationId: string;
    readonly runtimeGeneration: number | null;
}
/** Same-process observation only. JSON copies are descriptive, never verified evidence.
 * A stale generation can still be read with its ORIGINAL identity for audit; it cannot
 * satisfy a newer view. This does not grant execution or business acceptance. */
export declare function readNativeExecutionSnapshot(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined;
/** Internal current read: only the original issuer/result owner can follow live facts.
 * Audit snapshots and JSON copies intentionally have no current fence/owner. */
export declare function readCurrentNativeObservation(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined;
/** Internal freshness check for a live view; the public audit reader intentionally accepts history. */
export declare function readLatestNativeObservation(value: unknown, expected: NativeExecutionIdentity): NativeExecutionSnapshot | undefined;
/** Internal observer lifetime, not a claim that a process did or did not start. */
export declare function nativeObservationIsOpen(value: unknown, expected: NativeExecutionIdentity): boolean | undefined;
/** Internal adapter for orchestration-created cancellation/terminal wrappers. */
export declare function bindNativeResult(result: {
    correlationId: string;
}, observed: NativeExecutionSnapshot, generation: number | null): void;
/** Internal producer: deliberately not exported by the public observation port. */
export declare function createNativeObservation(input: NativeExecutionIdentity & {
    requestedTodoIds?: readonly string[];
    isCurrent?: () => boolean;
}, sink?: (snapshot: NativeExecutionSnapshot) => void): {
    executionControl(): void;
    enqueueInput(requestId: string, loopSeq: number): number;
    commitInput(generation: number): void;
    cancelInput(generation: number): void;
    acceptInput(ref: NativeInputReference): number | undefined;
    advanceLoop(ref?: NativeInputReference): number | undefined;
    beginTurn(ref?: NativeInputReference): number | undefined;
    agentSettled(ref: NativeInputReference | undefined, epoch: number | undefined): void;
    observeChild(child: ChildProcess): void;
    spawnThrew(): void;
    result(result: {
        exitCode: number;
        lifecyclePending?: boolean;
        wakeable?: boolean;
        terminalStatus?: string;
    }, turnReference?: NativeInputReference, epoch?: number): void;
};
