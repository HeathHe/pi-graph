import type {Clock} from "../contracts.ts";
import type {ObservationTarget,ObservationWaitStatus,ObservationSnapshot,ObserveParams,ObserveResult} from "./contracts.ts";
import type {ObservationRegistry} from "./registry.ts";
import {watchTargets} from "./watch.ts";
export function createObserveService<D>(registry:ObservationRegistry<D>,clock:Clock) {
function unavailable(target: ObservationTarget, waitStatus: ObservationWaitStatus, message: string): ObservationSnapshot<D> {
  return {
    target,
    found: false,
    nativeStatus: waitStatus,
    phase: "unknown",
    outcome: waitStatus === "aborted" ? "aborted" : "failure",
    waitStatus,
    summary: message,
    updatedAt: clock.now(),
    error: message,
  };
}

function failedObservation(target: ObservationTarget, error: unknown): ObservationSnapshot<D> {
  const message = error instanceof Error ? error.message : String(error);
  return unavailable(target, "failed", message);
}

function pendingObservation(target: ObservationTarget, waitStatus?: "timeout" | "aborted"): ObservationSnapshot<D> {
  return {
    target,
    found: true,
    nativeStatus: "pending",
    phase: "active",
    ...(waitStatus ? { waitStatus, outcome: waitStatus === "aborted" ? "aborted" as const : undefined } : {}),
    summary: waitStatus ? `Observation ${waitStatus}.` : "Still active.",
    updatedAt: clock.now(),
  };
}

function normalizedParams(params: ObserveParams): Required<Pick<ObserveParams, "detail" | "lines" | "waitMode" | "waitCount" | "timeoutMs" | "until">> {
  return {
    detail: params.detail ?? "summary",
    lines: params.lines ?? 20,
    waitMode: params.waitMode ?? "all",
    waitCount: params.waitCount ?? 1,
    timeoutMs: params.timeoutMs ?? 10 * 60_000,
    until: params.until ?? "result-ready",
  };
}

function validate(params: ObserveParams): void {
  if (params.targets.length === 0) throw new Error("Observe requires at least one target.");
  if (params.targets.some((target) => !target.kind.trim() || !target.id.trim())) {
    throw new Error("Every observation target requires non-empty kind and id.");
  }
  if (params.targets.some((target) => target.cursor !== undefined
    && (typeof target.cursor !== "string" || target.cursor.length < 1 || target.cursor.length > 2_048))) {
    throw new Error("Observe target cursor must be a string between 1 and 2048 characters.");
  }
  if (params.targets.some((target) => target.cursor !== undefined) && params.view !== "session") {
    throw new Error('Observe target cursor requires view="session".');
  }
  if (params.lines !== undefined && (!Number.isInteger(params.lines) || params.lines < 1 || params.lines > 500)) {
    throw new Error("Observe lines must be an integer between 1 and 500.");
  }
  if (params.timeoutMs !== undefined && (!Number.isInteger(params.timeoutMs) || params.timeoutMs < 1)) {
    throw new Error("Observe timeoutMs must be a positive integer.");
  }
  if ((params.action === "status" || params.action === "diagnose") && params.timeoutMs !== undefined) {
    throw new Error("Observe timeoutMs is supported only for wait and watch actions.");
  }
  if (
    params.action !== "wait"
    && (params.waitMode !== undefined || params.waitCount !== undefined || params.until !== undefined)
  ) {
    throw new Error("Observe waitMode, waitCount, and until are supported only for the wait action.");
  }
  if (params.waitCount !== undefined && params.waitMode !== "count") {
    throw new Error('Observe waitCount requires waitMode="count".');
  }
  if (params.waitMode === "count") {
    if (!Number.isInteger(params.waitCount) || (params.waitCount ?? 0) < 1 || (params.waitCount ?? 0) > params.targets.length) {
      throw new Error("Observe waitCount must be between 1 and the number of targets.");
    }
  }
  if (params.view !== undefined && params.view !== "live" && params.view !== "turns" && params.view !== "session" && params.view !== "todos") {
    throw new Error('Observe view must be "live", "turns", "session", or "todos".');
  }
  if (params.view === "turns" && params.action !== "status") {
    throw new Error('Observe view="turns" is supported only for the status action.');
  }
  if (params.view === "session" && params.action !== "status" && params.action !== "watch") {
    throw new Error('Observe view="session" is supported only for status and watch actions.');
  }
  if (params.view === "todos" && params.action !== "status" && params.action !== "watch") {
    throw new Error('Observe view="todos" is supported only for status and watch actions.');
  }
  if (params.view === "todos" && params.targets.some((target) => target.kind !== "workspace")) {
    throw new Error('Observe view="todos" requires workspace targets.');
  }
  if (params.turn !== undefined) {
    if (!Number.isInteger(params.turn) || params.turn < 1) throw new Error("Observe turn must be a positive integer.");
    if (params.view !== "turns") throw new Error('Observe turn requires view="turns".');
  }
}

async function observeTargets(params: ObserveParams, signal?: AbortSignal): Promise<ObserveResult<D>> {
  validate(params);
  const startedAt = clock.now();
  const options = normalizedParams(params);

  if (params.action === "status" || params.action === "diagnose") {
    const observations = await Promise.all(params.targets.map(async (target) => {
      const provider = registry.get(target.kind);
      if (!provider) return unavailable(target, "not-found", `No observation provider for kind \"${target.kind}\".`);
      try {
        return await provider.snapshot(target.id, {
          detail: options.detail,
          lines: options.lines,
          ...(params.action === "diagnose" ? { diagnose: true } : {}),
          ...(params.view ? { view: params.view } : {}),
          ...(target.cursor ? { cursor: target.cursor } : {}),
          ...(params.turn !== undefined ? { turn: params.turn } : {}),
        });
      } catch (error) {
        return failedObservation(target, error);
      }
    }));
    return { action: params.action, reason: "snapshot", observations, durationMs: clock.now() - startedAt };
  }

  if (params.action === "watch") {
    // Persistent observation: poll every target until the deadline, recording
    // every status transition within a bounded history (with latest snapshots
    // retained separately), which is richer than a one-shot status and
    // does not require a barrier condition like wait.
    return watchTargets(registry, clock, params, options, startedAt, signal);
  }

  const controller = new AbortController();
  const deadline = startedAt + options.timeoutMs;
  const observations = new Array<ObservationSnapshot<D> | undefined>(params.targets.length);
  const pending = new Set(params.targets.map((_target, index) => index));
  const required = options.waitMode === "all"
    ? params.targets.length
    : options.waitMode === "any"
      ? 1
      : options.waitCount;

  return new Promise<ObserveResult<D>>((resolve) => {
    let finished = false;
    let settledCount = 0;
    let timeout: { cancel(): void } | undefined;

    const finish = (reason: ObserveResult["reason"]): void => {
      if (finished) return;
      finished = true;
      timeout?.cancel();
      signal?.removeEventListener("abort", onAbort);
      controller.abort();
      const pendingStatus = reason === "timeout" ? "timeout" : reason === "aborted" ? "aborted" : undefined;
      const completed = params.targets.map((target, index) => observations[index] ?? pendingObservation(target, pendingStatus));
      resolve({ action: "wait", reason, observations: completed, durationMs: clock.now() - startedAt });
    };
    const onAbort = (): void => finish("aborted");

    // Arm the outer deadline before any provider wait starts. A provider cannot
    // strand later targets by delaying their timeout registration.
    timeout = clock.schedule(options.timeoutMs, () => finish("timeout"));
    if (signal?.aborted) {
      finish("aborted");
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    params.targets.forEach((target, index) => {
      const provider = registry.get(target.kind);
      const wait = provider
        ? Promise.resolve().then(() => {
            if (controller.signal.aborted) return pendingObservation(target);
            return provider.wait(target.id, {
              detail: options.detail,
              lines: options.lines,
              deadline,
              until: options.until,
              signal: controller.signal,
            });
          }).catch((error) => failedObservation(target, error))
        : Promise.resolve(unavailable(target, "not-found", `No observation provider for kind \"${target.kind}\".`));

      void wait.then((observation) => {
        if (finished || !pending.delete(index)) return;
        observations[index] = observation;
        settledCount += 1;
        if (settledCount < required) return;
        finish(options.waitMode);
      });
    });
  });
}


return {observeTargets};
}
