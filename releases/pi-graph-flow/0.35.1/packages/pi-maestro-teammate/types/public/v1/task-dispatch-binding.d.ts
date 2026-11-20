import { type TodoSourceScope } from "../../runs/todo-source-context.ts";
/** Process-local inversion port. A model supplies IDs, never a binding token. */
import { type NativeExecutionSnapshot } from "./observation.ts";
export declare const CHILD_MODEL_BUDGET_BROKER = "pi-graph:model-budget/1";
export declare const TASK_DISPATCH_ENTRY = "pi-graph-next:task-dispatch-prepared/1";
/** Pure projection only; it issues no budget authority or usage fact. */
export declare function childModelReceiptDigests(message: unknown): Readonly<{
    messageDigest: string;
    usageDigest: string;
}>;
export interface TaskDispatchManager {
    getSessionId(): string;
    getBranch(): readonly {
        id?: string;
        type?: string;
        customType?: string;
        data?: unknown;
    }[];
}
export interface TaskDispatchHost {
    readonly cwd: string;
    readonly sessionId: string;
    readonly manager: TaskDispatchManager;
}
export interface TaskDispatchRequest {
    readonly correlationId: string;
    readonly runtimeGeneration: number | null;
    readonly agent: string;
    readonly name?: string;
    readonly cwd: string;
    readonly todoIds: readonly string[];
}
export interface TaskDispatchContractRef {
    readonly taskId: string;
    readonly version: number;
    readonly taskDigest: string;
    readonly declaredDependencies?: readonly {
        readonly taskId: string;
        readonly version: number;
    }[];
    readonly planHandoffKey?: string;
    readonly qualityGoalId?: string;
}
export interface PreparedTaskDispatch {
    readonly contracts: readonly TaskDispatchContractRef[];
    readonly sessionId: string;
    readonly branchAnchor: string;
    readonly id: string;
    readonly agent: string;
    readonly cwd: string;
    readonly correlationId: string;
    readonly runtimeGeneration: number | null;
    readonly todoIds: readonly string[];
}
export interface TaskDispatchItemState {
    readonly taskId: string;
    readonly state: "active" | "ready" | "blocked" | "completed" | "historical" | "invalid_dependency";
    readonly stateRevision: number;
    readonly completionObserved?: boolean;
}
export interface TaskDispatchProvider {
    nativeRecovery?: TaskNativeRecoveryProvider;
    prepare(host: TaskDispatchHost, requests: readonly TaskDispatchRequest[], signal?: AbortSignal, cancellations?: readonly TaskDispatchCancellationScope[]): Promise<readonly PreparedTaskDispatch[]>;
    assertCurrent(token: PreparedTaskDispatch): void;
    inspect(token: PreparedTaskDispatch): readonly TaskDispatchItemState[];
    /** Read-only physical fact retention after cancellation. Never runnable authority. */
    inspectRecoveryFacts?(token: PreparedTaskDispatch): readonly TaskDispatchItemState[];
    waitReadiness(token: PreparedTaskDispatch, signal?: AbortSignal): Promise<void>;
}
/** Host mechanism port. None of these opaque values are model/tool DTOs. */
export interface TaskNativeRecoveryInput {
    readonly command: string;
    readonly payloadDigest: string;
    readonly wireRequestId?: string;
    readonly turn?: NativeExecutionSnapshot["currentTurn"];
}
export interface NativeTaskBudgetRequest {
    readonly requestId: string;
    readonly reservedUnits: number;
}
export interface BudgetAcquireControl {
    readonly signal?: AbortSignal;
    /** Tightens the original owner guard; cannot substitute for it. */
    readonly assertCurrent?: () => void;
}
/** Trusted host operations. Request/fact objects stay process-local and never enter model tools. */
export interface TaskNativeBudgetProvider {
    /** Same capture as prepare, without yielding or touching a budget database. */
    capture?(attempt: object): object | undefined;
    captureNone?(attempt: object): object;
    assertNone?(attempt: object, origin: object): void;
    prepare(attempt: object): Promise<object | undefined>;
    reserve(context: object, request: NativeTaskBudgetRequest): object;
    reserveRemaining?(context: object, requestId: string): object;
    acquireRemaining?(context: object, requestId: string, control: BudgetAcquireControl): Promise<object>;
    abandonBeforeMark?(request: object): void;
    markAttempted?(request: object): void;
    beginReceiptDrain?(request: object): object;
    endReceiptDrain?(producer: object): void;
    retireSender?(request: object): {
        recorded: boolean;
    };
    markMayHaveSent(request: object): void;
    recordUnknown(request: object): void;
    settle(request: object, originalFact: object): void;
    release(request: object, notSentProof: object): void;
}
/** Original loaded owner projection; opaque values never become model DTOs. */
export interface ParentModelBudgetSourcePort {
    capture(host: TaskDispatchHost): object;
    assertNone(origin: object): void;
    fromDispatch?(origin: object): object;
    kind?(origin: object): "none" | "declared";
    prepare?(origin: object): Promise<object>;
    reserve?(context: object): object;
    acquire?(context: object, control: BudgetAcquireControl): Promise<object>;
    abandonBeforeMark?(request: object): void;
    markAttempted?(request: object): void;
    beginReceiptDrain?(request: object): object;
    endReceiptDrain?(producer: object): void;
    retireSender?(request: object): {
        recorded: boolean;
    };
    mark?(request: object): void;
    unknown?(request: object): void;
    settleChild?(request: object, fact: object): void;
}
export interface TaskNativeRecoveryProvider {
    readonly backendBudgetSource?: {
        capture(host: TaskDispatchHost, todoIds: readonly string[]): object;
        assertNone(origin: object): void;
    };
    readonly modelSource?: ParentModelBudgetSourcePort;
    preflightBudget?(todoIds: readonly string[]): void;
    readonly budget?: TaskNativeBudgetProvider;
    ready(): Promise<void>;
    begin(token: PreparedTaskDispatch, candidateId: string, guard: () => void, factGuard: () => void): object;
    beforeWrite(attempt: object, input: TaskNativeRecoveryInput): object;
    consume(attempt: object, permit: object, payloadDigest: string): void;
    unknown(attempt: object): void;
    observe(attempt: object, snapshot: NativeExecutionSnapshot, cleanupRequested: boolean): void;
}
/** Issued in this module; no token is captured by a registration/signal listener. */
export interface TaskDispatchCancellationScope {
    readonly cancelled: boolean;
    /** Active wait only. Its disposer removes every original-signal listener. */
    subscribe(onCancel: () => void): () => void;
}
export declare function isTaskDispatchCancellationScope(value: unknown): value is TaskDispatchCancellationScope;
export declare function watchTaskDispatchCancellation(token: PreparedTaskDispatch | undefined, signal: AbortSignal | undefined): void;
export declare function registerTaskDispatchProvider(provider: TaskDispatchProvider): () => void;
export declare function prepareTaskDispatch(host: TaskDispatchHost | undefined, requests: readonly TaskDispatchRequest[], signal?: AbortSignal): Promise<readonly PreparedTaskDispatch[]>;
export declare function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest): void;
export declare function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest, budget: {
    readonly unmetered: "capture";
    readonly sourceScope?: TodoSourceScope;
}): object | undefined;
export declare function assertTaskDispatch(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest, budget: {
    readonly unmetered: "assert";
    readonly origin?: object;
}): void;
export declare function waitTaskDispatchReadiness(token: PreparedTaskDispatch | undefined, signal?: AbortSignal, request?: TaskDispatchRequest): Promise<void>;
export interface TaskDispatchObservation {
    readonly bindingId: string;
    readonly contracts: readonly TaskDispatchContractRef[];
    readonly sessionId: string;
    readonly branchAnchor: string;
    readonly todoIds: readonly string[];
    readonly bindingState: "current" | "historical";
    readonly items: readonly TaskDispatchItemState[];
    readonly native: NativeExecutionSnapshot;
}
export declare function joinTaskDispatchObservation(token: PreparedTaskDispatch, observed: NativeExecutionSnapshot): TaskDispatchObservation | undefined;
export declare function readTaskDispatchObservation(value: unknown): TaskDispatchObservation | undefined;
export declare function beginNativeTaskRecovery(token: PreparedTaskDispatch | undefined, request: TaskDispatchRequest): object | undefined;
export declare function beforeNativeTaskWrite(handle: object | undefined, input: Omit<TaskNativeRecoveryInput, "turn">): object | undefined;
export declare function consumeNativeTaskWrite(handle: object | undefined, permit: object | undefined, payloadDigest: string): void;
export declare function markNativeTaskWriteUnknown(handle: object | undefined): void;
export declare function markNativeTaskCleanup(handle: object | undefined): void;
export declare function observeNativeTaskRecovery(handle: object | undefined, value: unknown): void;
export declare function readChildModelUsageFact(fact: object, request: object): Readonly<{
    units: number;
    entryId: string;
    digest: string;
}>;
export declare function prepareNativeTaskBudget(handle: object | undefined): Promise<object | undefined>;
export declare function reserveNativeTaskBudgetRequest(context: object | undefined, request: NativeTaskBudgetRequest): object | undefined;
export declare function reserveNativeTaskBudgetRemaining(context: object, requestId: string): object;
export declare function markNativeTaskBudgetMayHaveSent(request: object | undefined): void;
export declare function recordNativeTaskBudgetUnknown(request: object): void;
export declare function settleNativeTaskBudgetRequest(request: object, originalFact: object): void;
export declare function releaseNativeTaskBudgetRequest(request: object, notSentProof: object): void;
/** Parent-local source minted before child startup. Never serialized into IPC. */
declare const childModelOrigin: unique symbol;
export interface ChildModelBudgetOrigin {
    readonly [childModelOrigin]: true;
}
export declare function captureChildModelBudgetOrigin(sourceScope: TodoSourceScope | undefined, nativeGate?: object): ChildModelBudgetOrigin;
/** Trusted actual-attempt capability; the negative-only API retains its contract. */
export declare function captureChildModelBudgetRequestOrigin(sourceScope: TodoSourceScope | undefined, nativeGate?: object, dispatch?: {
    readonly origin: object | undefined;
    readonly request: TaskDispatchRequest;
}): ChildModelBudgetOrigin;
export declare function assertChildModelBudgetNone(origin: ChildModelBudgetOrigin): Promise<void>;
export declare function readChildModelBudgetKind(origin: ChildModelBudgetOrigin): "none" | "declared";
export declare function reserveChildModelBudgetRequest(origin: ChildModelBudgetOrigin, requestId: string): object;
/** Prepare only: readiness may yield here, but no request or reservation exists. */
export declare function prepareChildModelBudgetContext(origin: ChildModelBudgetOrigin): Promise<object>;
/** Synchronous reservation after the actual IPC owner rechecks its session. */
export declare function reservePreparedChildModelBudgetRequest(prepared: object, parentRequestId: string): object;
/** Internal async acquisition; the returned handle already owns its CAS reservation. */
export declare function acquirePreparedChildModelBudgetRequest(prepared: object, parentRequestId: string, control: BudgetAcquireControl): Promise<object>;
export declare function abandonNativeTaskBudgetBeforeMark(request: object): void;
export declare function markNativeTaskBudgetAttempted(request: object): void;
export declare function beginNativeTaskBudgetReceiptDrain(request: object): object;
export declare function endNativeTaskBudgetReceiptDrain(producer: object): void;
/** Deny-only lifecycle metadata, never proof that a physical call finished or was not sent. */
export declare function retireNativeTaskBudgetSender(request: object): {
    recorded: boolean;
};
export {};
