import { CompactionArbiter as CoreCompactionArbiter, COMPACTION_LEASE_TIMEOUT_MS } from "pi-graph-context-runtime/arbiter";
import type { CompactionClockPort } from "pi-graph-context-runtime/contracts";

export * from "pi-graph-context-runtime/arbiter";

/** Host clock owns Node timers; core contains no ambient runtime dependencies. */
const hostClock: CompactionClockPort = {
  now: () => Date.now(),
  schedule(delayMs, callback) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/** Preserve the original public constructor while sharing one core arbiter. */
export class CompactionArbiter extends CoreCompactionArbiter {
  constructor(leaseTimeoutMs = COMPACTION_LEASE_TIMEOUT_MS) {
    super(leaseTimeoutMs, hostClock);
  }
}
