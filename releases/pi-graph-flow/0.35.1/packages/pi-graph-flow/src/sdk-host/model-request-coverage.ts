import { randomUUID } from "node:crypto";
import type { GoalBudgetCoveragePort, GoalBudgetJournalPin } from "../goal-coordinator/budget-source.ts";

/** One installed host epoch, not a balance or a permission to send. */
export function createModelRequestCoverage(assertCurrent: () => void): GoalBudgetCoveragePort & { bind(): void } {
  let bound = false;
  const hostEpoch = randomUUID();
  const issued = new WeakMap<object, { birth: GoalBudgetJournalPin; assertSource(): void; initialized: boolean }>();
  return {
    bind() { assertCurrent(); bound = true; },
    epoch() { assertCurrent(); return hostEpoch; },
    snapshot(proof, birth) { this.assert(proof, birth); return { hostEpoch, initialized: issued.get(proof)!.initialized }; },
    adopt(birth, assertSource, initialized) {
      // The original Goal owner has already verified the new native issuer's
      // opaque adoption handle. This still cannot send until bind().
      assertCurrent(); assertSource(); const proof = Object.freeze({});
      issued.set(proof, { birth: { ...birth }, assertSource, initialized }); return proof;
    },
    birth(_goalId, birth, assertSource) {
      assertCurrent(); if (!bound) return undefined;
      assertSource(); const proof = Object.freeze({});
      issued.set(proof, { birth: { ...birth }, assertSource, initialized: false }); return proof;
    },
    assert(proof, birth) {
      assertCurrent(); const record = issued.get(proof);
      if (!bound || !record || record.birth.entryId !== birth.entryId || record.birth.digest !== birth.digest) throw new Error("Goal request coverage is unavailable or belongs to another birth");
      record.assertSource();
    },
    initialize(proof, birth) {
      this.assert(proof, birth); const record = issued.get(proof)!;
      if (record.initialized) throw new Error("Goal request coverage cannot initialize the same pool twice");
      // Consume before entering the store transaction. Failure is conservative;
      // an uncertain commit may never authorize a second known-empty history.
      record.initialized = true;
      return { kind: "known", debits: [] };
    },
  };
}
