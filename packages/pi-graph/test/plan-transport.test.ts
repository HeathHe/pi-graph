import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlanTransports,
  registerPlanTransport,
  type PlanTransport,
} from "../src/plan-transport.ts";

function fixture(): PlanTransport {
  return {
    open() {
      return {
        promise: Promise.resolve({ status: "cancelled" as const }),
        cancel() {},
      };
    },
  };
}

test("Plan transport registry registers, snapshots and disposes transports", () => {
  const transport = fixture();
  const before = getPlanTransports();
  const dispose = registerPlanTransport(transport);
  try {
    const current = getPlanTransports();
    assert.equal(current.includes(transport), true);
    assert.notEqual(current, getPlanTransports());
    assert.equal(getPlanTransports().length, before.length + 1);
    dispose();
    assert.equal(getPlanTransports().includes(transport), false);
  } finally {
    dispose();
  }
});

test("Plan transport registration is idempotent for the same object", () => {
  const transport = fixture();
  const disposeA = registerPlanTransport(transport);
  const disposeB = registerPlanTransport(transport);
  try {
    assert.equal(getPlanTransports().filter((entry) => entry === transport).length, 1);
  } finally {
    disposeA();
    disposeB();
  }
  assert.equal(getPlanTransports().includes(transport), false);
});
