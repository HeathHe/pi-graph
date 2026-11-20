import { randomUUID } from "node:crypto";
import type { CompletionDispatchDurability } from "../completion-outbox/coordinator.ts";
import type {
  CompletionDispatchSeed,
  CompletionKind,
  CompletionReplyTarget,
  CompletionTarget,
} from "../public/v1/completion-durability.ts";
import { truncateUtf8Head } from "../runs/execution-infra.ts";

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

interface ParallelCompletionPublication<T> {
  value: T;
  failed: boolean;
}

type ParallelCompletionState = "buffering" | "activating" | "active" | "foreground" | "abandoned";

const LOCAL_PARALLEL_COORDINATOR: ParallelCompletionCoordinator = {
  async beginDispatch() { return { durable: false }; },
  async requireNotification() {},
  async abandon() {},
  async settleForeground() {},
};

function parallelSeeds(
  options: ParallelCompletionSeedOptions,
  target: CompletionTarget,
  replyTarget: CompletionReplyTarget,
): CompletionDispatchSeed[] {
  if (options.taskCorrelationIds.length < 2) {
    throw new Error("Parallel completion requires at least two task correlation IDs.");
  }
  if (new Set(options.taskCorrelationIds).size !== options.taskCorrelationIds.length) {
    throw new Error("Parallel completion task correlation IDs must be unique.");
  }
  const createdAt = options.createdAt ?? Date.now();
  const reservationId = options.reservationId ?? randomUUID;
  return options.taskCorrelationIds.map((correlationId) => ({
    dispatchId: correlationId,
    deliveryGroupId: options.parentDispatchId,
    reservationId: reservationId(),
    mode: "parallel" as const,
    target,
    replyTarget,
    originCwd: options.originCwd,
    expectedTasks: [correlationId],
    createdAt,
  }));
}

async function cleanAdmittedSeeds(
  coordinator: ParallelCompletionCoordinator,
  seeds: readonly CompletionDispatchSeed[],
  reason: string,
): Promise<void> {
  await Promise.allSettled(seeds.map((seed) => coordinator.abandon(seed, reason)));
}

export class ParallelCompletionController<T> {
  readonly #coordinator: ParallelCompletionCoordinator;
  readonly #seeds: Map<string, CompletionDispatchSeed>;
  readonly #taskOrder: readonly string[];
  readonly #durable: boolean;
  readonly #publications = new Map<string, ParallelCompletionPublication<T>>();
  readonly #inFlight = new Set<string>();
  readonly #delivered = new Set<string>();
  #state: ParallelCompletionState = "buffering";
  #activationPromise: Promise<void> | undefined;

  private constructor(
    coordinator: ParallelCompletionCoordinator,
    seeds: readonly CompletionDispatchSeed[],
    durable: boolean,
  ) {
    this.#coordinator = coordinator;
    this.#seeds = new Map(seeds.map((seed) => [seed.dispatchId, seed]));
    this.#taskOrder = seeds.map((seed) => seed.dispatchId);
    this.#durable = durable;
  }

  static nonDurable<T>(options: ParallelCompletionSeedOptions): ParallelCompletionController<T> {
    const seeds = parallelSeeds(
      options,
      { workspaceId: "local", sessionId: options.parentDispatchId },
      "caller",
    );
    return new ParallelCompletionController(LOCAL_PARALLEL_COORDINATOR, seeds, false);
  }

  static async admit<T>(options: ParallelCompletionAdmissionOptions): Promise<ParallelCompletionController<T>> {
    const seeds = parallelSeeds(options, options.target, options.replyTarget);
    const admitted: CompletionDispatchSeed[] = [];
    let durable: boolean | undefined;
    try {
      for (const seed of seeds) {
        const current = await options.coordinator.beginDispatch(seed);
        if (durable === undefined) durable = current.durable;
        else if (durable !== current.durable) {
          if (current.durable) admitted.push(seed);
          throw new Error("Parallel completion durability changed during child-seed admission.");
        }
        if (current.durable) admitted.push(seed);
      }
    } catch (error) {
      await cleanAdmittedSeeds(
        options.coordinator,
        admitted,
        "parallel completion child-seed admission failed",
      );
      throw error;
    }

    return new ParallelCompletionController(options.coordinator, seeds, durable === true);
  }

  get durable(): boolean {
    return this.#durable;
  }

  get state(): ParallelCompletionState {
    return this.#state;
  }

  seedFor(correlationId: string): CompletionDispatchSeed | undefined {
    return this.#seeds.get(correlationId);
  }

  completionIdentity(correlationId: string): Pick<CompletionDispatchSeed, "dispatchId" | "reservationId"> | undefined {
    if (!this.#durable) return undefined;
    const seed = this.#seeds.get(correlationId);
    return seed ? { dispatchId: seed.dispatchId, reservationId: seed.reservationId } : undefined;
  }

  record(
    correlationId: string,
    value: T,
    failed: boolean,
  ): ParallelCompletionDelivery<T> | undefined {
    if (!this.#seeds.has(correlationId)) {
      throw new Error(`Unknown parallel completion task ${correlationId}.`);
    }
    if (this.#state === "foreground" || this.#state === "abandoned") return undefined;
    if (this.#publications.has(correlationId)) return undefined;
    this.#publications.set(correlationId, { value, failed });
    return this.#state === "active" ? this.#claim(correlationId) : undefined;
  }

  async activateNotifications(kind: CompletionKind = "single"): Promise<ParallelCompletionDelivery<T>[]> {
    if (this.#state === "foreground" || this.#state === "abandoned") return [];
    if (this.#state !== "active") {
      if (!this.#activationPromise) {
        this.#state = "activating";
        this.#activationPromise = (async () => {
          try {
            if (this.#durable) {
              for (const seed of this.#seeds.values()) {
                await this.#coordinator.requireNotification({
                  dispatchId: seed.dispatchId,
                  reservationId: seed.reservationId,
                  kind,
                  requiredAt: Date.now(),
                });
              }
            }
            this.#state = "active";
          } catch (error) {
            await this.abandon("parallel completion notification activation failed");
            throw error;
          }
        })().finally(() => {
          this.#activationPromise = undefined;
        });
      }
      await this.#activationPromise;
    }
    return this.#claimReady();
  }

  retry(correlationId: string): ParallelCompletionDelivery<T> | undefined {
    if (this.#state !== "active") return undefined;
    return this.#claim(correlationId);
  }

  finishDelivery(correlationId: string, delivered: boolean): void {
    this.#inFlight.delete(correlationId);
    if (delivered) this.#delivered.add(correlationId);
  }

  async settleForeground(): Promise<void> {
    if (this.#state === "active" || this.#state === "activating") {
      throw new Error("Parallel completion notification activation has already started.");
    }
    if (this.#state === "foreground" || this.#state === "abandoned") return;
    this.#state = "foreground";
    if (!this.#durable) return;
    const outcomes = await Promise.allSettled(
      [...this.#seeds.values()].map((seed) => this.#coordinator.settleForeground(seed)),
    );
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => (failure as PromiseRejectedResult).reason),
        "Failed to settle one or more parallel completion child seeds as foreground.",
      );
    }
  }

  async abandon(reason: string): Promise<void> {
    if (this.#state === "abandoned") return;
    this.#state = "abandoned";
    if (!this.#durable) return;
    await cleanAdmittedSeeds(this.#coordinator, [...this.#seeds.values()], reason);
  }

  snapshot(): ParallelCompletionSnapshot {
    const ready = this.#publications.size;
    const failed = [...this.#publications.values()].filter((publication) => publication.failed).length;
    return {
      total: this.#taskOrder.length,
      ready,
      failed,
      remaining: this.#taskOrder.length - ready,
    };
  }

  #claimReady(): ParallelCompletionDelivery<T>[] {
    const deliveries: ParallelCompletionDelivery<T>[] = [];
    for (const correlationId of this.#taskOrder) {
      const delivery = this.#claim(correlationId);
      if (delivery) deliveries.push(delivery);
    }
    return deliveries;
  }

  #claim(correlationId: string): ParallelCompletionDelivery<T> | undefined {
    if (this.#state !== "active"
      || this.#inFlight.has(correlationId)
      || this.#delivered.has(correlationId)) return undefined;
    const publication = this.#publications.get(correlationId);
    if (!publication) return undefined;
    this.#inFlight.add(correlationId);
    return {
      correlationId,
      value: publication.value,
      snapshot: this.snapshot(),
    };
  }
}

export function formatParallelCompletionStatus(snapshot: ParallelCompletionSnapshot): string {
  return `Parallel status: ${snapshot.ready}/${snapshot.total} results ready · ${snapshot.failed} failed · ${snapshot.remaining} remaining`;
}

export function formatParallelCompletionMessage(input: {
  label: string;
  correlationId: string;
  resourceUri: `agent://${string}`;
  resultSummary: string;
  snapshot: ParallelCompletionSnapshot;
  maxBytes?: number;
}): string {
  const maxBytes = input.maxBytes ?? 4_096;
  const prefix = `@${input.label} result ready · ${input.correlationId}\n${input.resourceUri}\n\n`;
  const suffix = `\n\n${formatParallelCompletionStatus(input.snapshot)}`;
  const fixedBytes = Buffer.byteLength(prefix, "utf8") + Buffer.byteLength(suffix, "utf8");
  if (fixedBytes >= maxBytes) return truncateUtf8Head(`${prefix}${suffix}`, maxBytes);
  const summary = truncateUtf8Head(input.resultSummary, maxBytes - fixedBytes);
  return `${prefix}${summary}${suffix}`;
}
