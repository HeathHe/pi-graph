import type { CompletionDispatchDurability } from "../completion-outbox/coordinator.ts";
import type { CompletionDispatchSeed, CompletionKind, CompletionReplyTarget, CompletionTarget } from "../public/v1/completion-durability.ts";
export interface ParallelCompletionCoordinator {
    beginDispatch(seed: CompletionDispatchSeed): Promise<CompletionDispatchDurability>;
    requireNotification(input: {
        dispatchId: string;
        reservationId: string;
        kind: CompletionKind;
        requiredAt: number;
    }): Promise<void>;
    abandon(seed: CompletionDispatchSeed, reason: string): Promise<void>;
    settleForeground(seed: CompletionDispatchSeed): Promise<void>;
}
export interface ParallelCompletionSeedOptions {
    parentDispatchId: string;
    taskCorrelationIds: readonly string[];
    originCwd: string;
    createdAt?: number;
    reservationId?: () => string;
}
export interface ParallelCompletionAdmissionOptions extends ParallelCompletionSeedOptions {
    target: CompletionTarget;
    replyTarget: CompletionReplyTarget;
    coordinator: ParallelCompletionCoordinator;
}
export interface ParallelCompletionSnapshot {
    total: number;
    ready: number;
    failed: number;
    remaining: number;
}
export interface ParallelCompletionDelivery<T> {
    correlationId: string;
    value: T;
    snapshot: ParallelCompletionSnapshot;
}
type ParallelCompletionState = "buffering" | "activating" | "active" | "foreground" | "abandoned";
export declare class ParallelCompletionController<T> {
    #private;
    private constructor();
    static nonDurable<T>(options: ParallelCompletionSeedOptions): ParallelCompletionController<T>;
    static admit<T>(options: ParallelCompletionAdmissionOptions): Promise<ParallelCompletionController<T>>;
    get durable(): boolean;
    get state(): ParallelCompletionState;
    seedFor(correlationId: string): CompletionDispatchSeed | undefined;
    completionIdentity(correlationId: string): Pick<CompletionDispatchSeed, "dispatchId" | "reservationId"> | undefined;
    record(correlationId: string, value: T, failed: boolean): ParallelCompletionDelivery<T> | undefined;
    activateNotifications(kind?: CompletionKind): Promise<ParallelCompletionDelivery<T>[]>;
    retry(correlationId: string): ParallelCompletionDelivery<T> | undefined;
    finishDelivery(correlationId: string, delivered: boolean): void;
    settleForeground(): Promise<void>;
    abandon(reason: string): Promise<void>;
    snapshot(): ParallelCompletionSnapshot;
}
export declare function formatParallelCompletionStatus(snapshot: ParallelCompletionSnapshot): string;
export declare function formatParallelCompletionMessage(input: {
    label: string;
    correlationId: string;
    resourceUri: `agent://${string}`;
    resultSummary: string;
    snapshot: ParallelCompletionSnapshot;
    maxBytes?: number;
}): string;
export {};
