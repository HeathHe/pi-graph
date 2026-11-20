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

export function describeSupervisionError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function runSupervisedEvaluation<T = unknown>(
  dispatch: SupervisionDispatch,
  params: SupervisedEvaluationParams,
): Promise<SupervisedEvaluationResult<T>> {
  const {
    maxFailures = 3,
    deadlineMs = 0,
    outputSchema,
    fallbackTextParser,
    beforeVerdict,
    isRetryable,
  } = params;

  const controller = new AbortController();
  const parentSignal = params.signal;
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });

  const deadlineError = new Error(`Supervised evaluation timed out after ${deadlineMs}ms.`);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (deadlineMs > 0) {
    // Not unref'd: the deadline must keep the event loop alive while the
    // dispatch is pending (mocked dispatches have no child-process handle).
    deadlineTimer = setTimeout(() => {
      controller.abort(deadlineError);
    }, deadlineMs);
  }

  let lastError: unknown;
  let lastResult: SingleResult | undefined;
  try {
    for (let attempt = 1; attempt <= maxFailures; attempt++) {
      if (controller.signal.aborted) break;
      try {
        const result = await dispatch({
          task: params.task,
          signal: controller.signal,
          timeoutMs: params.timeoutMs,
          outputSchema,
        });
        lastResult = result;
        if (beforeVerdict) {
          const gateReason = beforeVerdict(result);
          if (gateReason !== undefined) {
            return { ok: false, raw: result, reason: gateReason };
          }
        }
        if (result.structuredOutput !== undefined) {
          return { ok: true, verdict: result.structuredOutput as T, raw: result };
        }
        if (fallbackTextParser) {
          const text = result.messages[result.messages.length - 1]?.content ?? "";
          const verdict = fallbackTextParser(text);
          if (verdict !== undefined) {
            return { ok: true, verdict: verdict as T, raw: result };
          }
        }
        return {
          ok: false,
          raw: result,
          reason: "Evaluation produced no structured output and no parseable text verdict.",
        };
      } catch (error) {
        lastError = error;
        if (isRetryable && !isRetryable(error)) {
          return { ok: false, raw: lastResult, reason: `Evaluation failed: ${describeSupervisionError(error)}` };
        }
        // otherwise retry
      }
    }

    return {
      ok: false,
      raw: lastResult,
      reason: controller.signal.aborted
        ? `Supervised evaluation aborted: ${describeSupervisionError(controller.signal.reason ?? deadlineError)}`
        : `Evaluation failed after ${maxFailures} attempt(s): ${lastError === undefined ? "no result" : describeSupervisionError(lastError)}`,
    };
  } finally {
    if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Unified delivery gate: cooldown, normalized dedupe, phrase filtering,
 * per-window limit, and interrupt downgrade (immuneTurns semantics).
 *
 * Pure state machine — no host dependency; unit-testable. Shared by the
 * fleet Monitor engine (per-target cooldown + dedupe) and the future
 * turn-level Advisor (global emission guard + immuneTurns).
 *
 * Suppression contract: a suppressed call registers nothing (cooldown,
 * window count, dedupe history) — identical to the advisor emission guard,
 * where a noise call never displaces a real concern that follows.
 */

const DEFAULT_PHRASE_FILTER = [
  "stop",
  "done",
  "complete",
  "no issue continue",
  "lgtm",
  "nothing to add",
  "no further input",
] as const;

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

export function normalizeDeliveryMessage(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export class DeliveryGate {
  private readonly cooldownMs: number;
  private readonly dedup: DeliveryDedupOptions | undefined;
  private readonly phraseFilter: readonly string[] | false;
  private readonly perWindowLimit: number;
  private readonly downgradeAfter: number;

  private readonly lastDeliveryAt = new Map<string, number>();
  private readonly dedupeHistory = new Set<string>();
  private readonly dedupeOrder: string[] = [];
  private readonly windowCounts = new Map<string, number>();
  /** Per-target remaining downgrade windows after an interrupt delivery. */
  private readonly downgradeBudget = new Map<string, number>();

  constructor(options: DeliveryOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.dedup = options.dedup === false ? undefined : options.dedup ?? { capacity: 4096, scope: "global" };
    this.phraseFilter = options.phraseFilter === false ? false : options.phraseFilter ?? DEFAULT_PHRASE_FILTER;
    this.perWindowLimit = options.perWindowLimit ?? 1;
    this.downgradeAfter = options.downgradeAfter ?? 3;
  }

  /**
   * Evaluate and record a candidate delivery. Returns the mode to use, or
   * undefined when the delivery must be suppressed. Suppression is invisible
   * to the caller — identical to the advisor emission guard contract.
   */
  gate(target: string, message: string, requested: DeliveryMode): DeliveryMode | undefined {
    if (this.phraseFilter && this.phraseFilter.includes(normalizeDeliveryMessage(message))) {
      return undefined;
    }

    const now = Date.now();
    const last = this.lastDeliveryAt.get(target);
    if (last !== undefined && now - last < this.cooldownMs) {
      return undefined;
    }

    const windowCount = this.windowCounts.get(target) ?? 0;
    if (windowCount >= this.perWindowLimit) {
      return undefined;
    }

    let dedupeKey: string | undefined;
    if (this.dedup) {
      const normalized = (this.dedup.normalize ?? normalizeDeliveryMessage)(message);
      dedupeKey = this.dedup.scope === "target" ? `${target}\u0000${normalized}` : normalized;
      if (this.dedupeHistory.has(dedupeKey)) {
        return undefined;
      }
    }

    // Accept: register cooldown, window count, dedupe history, delivery mode.
    this.windowCounts.set(target, windowCount + 1);
    this.lastDeliveryAt.set(target, now);
    if (dedupeKey !== undefined) {
      this.dedupeHistory.add(dedupeKey);
      this.dedupeOrder.push(dedupeKey);
      const capacity = this.dedup?.capacity ?? 4096;
      if (this.dedupeOrder.length > capacity) {
        const evicted = this.dedupeOrder.shift();
        if (evicted !== undefined) this.dedupeHistory.delete(evicted);
      }
    }

    let mode = requested;
    if (requested === "interrupt") {
      const budget = this.downgradeBudget.get(target) ?? 0;
      if (budget > 0) {
        mode = "batch";
        this.downgradeBudget.set(target, budget - 1);
      } else {
        this.downgradeBudget.set(target, this.downgradeAfter);
      }
    }
    return mode;
  }

  /** Marks the start of a new evaluation window (tick / turn). */
  beginWindow(): void {
    this.windowCounts.clear();
  }

  /** Clears dedupe history, cooldown and downgrade state (compaction / session switch). */
  reset(): void {
    this.lastDeliveryAt.clear();
    this.dedupeHistory.clear();
    this.dedupeOrder.length = 0;
    this.windowCounts.clear();
    this.downgradeBudget.clear();
  }
}

const ADVISOR_RUNTIME_REGISTRY = Symbol.for("pi-maestro.advisor-runtime.v1");

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

interface RegisteredAdvisorRuntime extends AdvisorRuntimeCandidate {
  generation: number;
  order: number;
}

interface AdvisorRuntimeRegistryState {
  candidates: Map<string, RegisteredAdvisorRuntime>;
  commandHosts: WeakSet<object>;
  nextGeneration: number;
  nextOrder: number;
}

function registryState(): AdvisorRuntimeRegistryState {
  const host = globalThis as Record<symbol, AdvisorRuntimeRegistryState | undefined>;
  let state = host[ADVISOR_RUNTIME_REGISTRY];
  if (!state) {
    state = {
      candidates: new Map(),
      commandHosts: new WeakSet(),
      nextGeneration: 1,
      nextOrder: 1,
    };
    host[ADVISOR_RUNTIME_REGISTRY] = state;
  }
  return state;
}

function currentOwner(state = registryState()): RegisteredAdvisorRuntime | undefined {
  let owner: RegisteredAdvisorRuntime | undefined;
  for (const candidate of state.candidates.values()) {
    if (!owner
      || candidate.priority > owner.priority
      || (candidate.priority === owner.priority && candidate.order < owner.order)) {
      owner = candidate;
    }
  }
  return owner;
}

function sameRegistration(
  left: RegisteredAdvisorRuntime | undefined,
  right: RegisteredAdvisorRuntime | undefined,
): boolean {
  return left?.id === right?.id && left?.generation === right?.generation;
}

function notifyOwnership(candidate: RegisteredAdvisorRuntime | undefined, owned: boolean): void {
  if (!candidate?.onOwnershipChanged) return;
  try {
    candidate.onOwnershipChanged(owned);
  } catch {
    // Ownership arbitration must remain available even when one runtime's
    // best-effort lifecycle cleanup fails.
  }
}

export function registerAdvisorRuntime(candidate: AdvisorRuntimeCandidate): AdvisorRuntimeLease {
  const id = candidate.id.trim();
  if (!id) throw new Error("Advisor runtime id must be non-empty");
  if (!Number.isFinite(candidate.priority)) throw new Error("Advisor runtime priority must be finite");

  const state = registryState();
  const previousOwner = currentOwner(state);
  const previousRegistration = state.candidates.get(id);
  const registration: RegisteredAdvisorRuntime = {
    ...candidate,
    id,
    generation: state.nextGeneration++,
    order: previousRegistration?.order ?? state.nextOrder++,
  };
  state.candidates.set(id, registration);
  const nextOwner = currentOwner(state);

  const notified = new Set<RegisteredAdvisorRuntime>();
  const notifyOnce = (target: RegisteredAdvisorRuntime | undefined, owned: boolean) => {
    if (!target || notified.has(target)) return;
    notified.add(target);
    notifyOwnership(target, owned);
  };

  if (previousRegistration && !sameRegistration(previousRegistration, previousOwner)) {
    notifyOnce(previousRegistration, false);
  }
  if (!sameRegistration(previousOwner, nextOwner)) {
    notifyOnce(previousOwner, false);
    notifyOnce(nextOwner, true);
  }
  if (!sameRegistration(registration, nextOwner)) {
    notifyOnce(registration, false);
  }

  let released = false;
  return {
    isOwner() {
      if (released) return false;
      const active = state.candidates.get(id);
      return active?.generation === registration.generation
        && sameRegistration(currentOwner(state), registration);
    },
    release() {
      if (released) return;
      released = true;
      const active = state.candidates.get(id);
      if (active?.generation !== registration.generation) return;
      const ownerBeforeRelease = currentOwner(state);
      state.candidates.delete(id);
      const ownerAfterRelease = currentOwner(state);
      notifyOwnership(registration, false);
      if (!sameRegistration(ownerBeforeRelease, ownerAfterRelease)
        && !sameRegistration(registration, ownerAfterRelease)) {
        notifyOwnership(ownerAfterRelease, true);
      }
    },
  };
}

export function getAdvisorRuntimeOwner(): string | undefined {
  return currentOwner()?.id;
}

type AdvisorCommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

export function registerAdvisorCommandHost(
  host: object,
  register: (handler: AdvisorCommandHandler) => void,
  notifyUnavailable: (ctx: ExtensionCommandContext) => void,
): void {
  const state = registryState();
  if (state.commandHosts.has(host)) return;
  state.commandHosts.add(host);
  register(async (args, ctx) => {
    const owner = currentOwner();
    if (!owner) {
      notifyUnavailable(ctx);
      return;
    }
    await owner.handleCommand(args, ctx);
  });
}
