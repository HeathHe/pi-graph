import { type NativeExecutionIdentity, type NativeExecutionSnapshot } from "./native-observation.ts";
/** Opaque same-process read capability. Deserializing this shape grants nothing. */
export interface NativeCurrentReadCapability {
    readonly namespace: "pi-graph-next:native-current/1";
}
export interface NativeCurrentView extends NativeExecutionIdentity {
    readonly revision: number;
    readonly candidateRevision: number;
    readonly current?: NativeExecutionSnapshot;
    /** Positive spawn without a corresponding close, including superseded candidates. */
    readonly pending: readonly NativeExecutionSnapshot[];
}
/** Internal subscription lifetime only; neither physical closure nor business acceptance. */
export declare function readNativeCurrentLifetime(capability: object): {
    readonly executionCallSettled: boolean;
    readonly openObservations: number;
} | undefined;
export declare function readNativeCurrent(capability: unknown): NativeCurrentView | undefined;
export declare function subscribeNativeCurrent(capability: unknown, listener: () => void): () => void;
/** Internal execution owner, never exported from the public observation facade. */
export declare function createNativeCurrentView(identity: NativeExecutionIdentity): {
    capability: NativeCurrentReadCapability;
    settleExecutionCall(): void;
    beginCandidate(): number;
    observe(candidate: number, value: unknown): void;
};
