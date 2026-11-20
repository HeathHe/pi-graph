import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SingleResult } from "../shared/types.ts";
import type { TeammateThinkingInput } from "../shared/thinking.ts";
/**
 * Unified model-evaluation wrapper shared by supervision consumers
 * (Goal verifier, Monitor drift analysis, future Advisor).
 *
 * Semantics:
 *  - an overall `deadlineMs` aborts the dispatch signal (child tree) when exceeded
 *  - consecutive dispatch failures retry up to `maxFailures`, then give up
 *  - verdict extraction: structured output first, then `fallbackTextParser`
 *  - failures never throw: the result carries `{ ok: false }` plus a reason
 */
export interface SupervisedEvaluationParams {
    task: string;
    agent?: string;
    thinking?: TeammateThinkingInput;
    /** Per-attempt budget forwarded to the dispatch; caller decides how to apply. */
    timeoutMs?: number;
    /** Overall deadline; aborts the dispatch signal when exceeded. 0 disables. */
    deadlineMs?: number;
    outputSchema?: Record<string, unknown>;
    /** Legacy text-verdict fallback used when structured output is absent. */
    fallbackTextParser?: (text: string) => unknown;
    /** Consecutive dispatch failures before giving up. Default 3. */
    maxFailures?: number;
    /** Caller gate: return a failure reason to reject a result before verdict extraction. */
    beforeVerdict?: (result: SingleResult) => string | undefined;
    /** Retryability predicate; default retries every failure. */
    isRetryable?: (error: unknown) => boolean;
    /** Parent signal cascaded into the internal abort controller. */
    signal?: AbortSignal;
}
export interface SupervisedEvaluationContext {
    task: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    outputSchema?: Record<string, unknown>;
}
export type SupervisionDispatch = (ctx: SupervisedEvaluationContext) => Promise<SingleResult>;
export interface SupervisedEvaluationResult<T = unknown> {
    ok: boolean;
    verdict?: T;
    raw?: SingleResult;
    reason?: string;
}
export declare function describeSupervisionError(error: unknown): string;
export declare function runSupervisedEvaluation<T = unknown>(dispatch: SupervisionDispatch, params: SupervisedEvaluationParams): Promise<SupervisedEvaluationResult<T>>;
export type DeliveryMode = "interrupt" | "batch" | "notify";
export interface DeliveryDedupOptions {
    /** FIFO ring capacity. Default 4096. */
    capacity?: number;
    /**
     * Dedupe scope: "global" = session-wide content dedupe (advisor
     * emission-guard semantics); "target" = per-target content dedupe
     * (monitor semantics: the same correction may go to different agents).
     * Default "global".
     */
    scope?: "global" | "target";
    /** Message normalizer; default is normalizeDeliveryMessage. */
    normalize?: (message: string) => string;
}
export interface DeliveryOptions {
    /** Minimum interval between two deliveries to the same target. Default 60_000. */
    cooldownMs?: number;
    /** Content dedupe; pass false to disable. */
    dedup?: false | DeliveryDedupOptions;
    /** Phrase filter; default builtin list, pass false to disable. */
    phraseFilter?: readonly string[] | false;
    /** Max deliveries per target per evaluation window. Default 1. */
    perWindowLimit?: number;
    /** After an interrupt delivery, downgrade the next N windows' interrupts to batch. Default 3. */
    downgradeAfter?: number;
}
export declare function normalizeDeliveryMessage(message: string): string;
export declare class DeliveryGate {
    private readonly cooldownMs;
    private readonly dedup;
    private readonly phraseFilter;
    private readonly perWindowLimit;
    private readonly downgradeAfter;
    private readonly lastDeliveryAt;
    private readonly dedupeHistory;
    private readonly dedupeOrder;
    private readonly windowCounts;
    /** Per-target remaining downgrade windows after an interrupt delivery. */
    private readonly downgradeBudget;
    constructor(options?: DeliveryOptions);
    /**
     * Evaluate and record a candidate delivery. Returns the mode to use, or
     * undefined when the delivery must be suppressed. Suppression is invisible
     * to the caller — identical to the advisor emission guard contract.
     */
    gate(target: string, message: string, requested: DeliveryMode): DeliveryMode | undefined;
    /** Marks the start of a new evaluation window (tick / turn). */
    beginWindow(): void;
    /** Clears dedupe history, cooldown and downgrade state (compaction / session switch). */
    reset(): void;
}
export interface AdvisorRuntimeCandidate {
    id: string;
    priority: number;
    handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> | void;
    onOwnershipChanged?(owned: boolean): void;
}
export interface AdvisorRuntimeLease {
    isOwner(): boolean;
    release(): void;
}
export declare function registerAdvisorRuntime(candidate: AdvisorRuntimeCandidate): AdvisorRuntimeLease;
export declare function getAdvisorRuntimeOwner(): string | undefined;
type AdvisorCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;
export declare function registerAdvisorCommandHost(host: object, register: (handler: AdvisorCommandHandler) => void, notifyUnavailable: (ctx: ExtensionCommandContext) => void): void;
export {};
