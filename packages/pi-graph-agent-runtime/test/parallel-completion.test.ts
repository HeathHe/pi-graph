import assert from "node:assert/strict";
import test from "node:test";
import type { CompletionDispatchSeed } from "../src/public/v1/completion-durability.ts";
import {
  ParallelCompletionController,
  formatParallelCompletionMessage,
  formatParallelCompletionStatus,
  type ParallelCompletionCoordinator,
} from "../src/extension/parallel-completion.ts";

class FakeCoordinator implements ParallelCompletionCoordinator {
  readonly began: CompletionDispatchSeed[] = [];
  readonly required: Array<{ dispatchId: string; kind: string }> = [];
  readonly abandoned: Array<{ dispatchId: string; reason: string }> = [];
  readonly foreground: string[] = [];
  rejectNotificationFor: string | undefined;
  readonly #durability: boolean[];

  constructor(durability: boolean[]) {
    this.#durability = [...durability];
  }

  async beginDispatch(seed: CompletionDispatchSeed) {
    this.began.push(seed);
    const durable = this.#durability.shift() ?? false;
    return durable
      ? {
          durable: true,
          handle: {
            dispatchId: seed.dispatchId,
            reservationId: seed.reservationId,
            deliveryGroupId: seed.deliveryGroupId,
          },
        }
      : { durable: false };
  }

  async requireNotification(input: { dispatchId: string; kind: string }) {
    if (input.dispatchId === this.rejectNotificationFor) throw new Error("notification activation failed");
    this.required.push({ dispatchId: input.dispatchId, kind: input.kind });
  }

  async abandon(seed: CompletionDispatchSeed, reason: string) {
    this.abandoned.push({ dispatchId: seed.dispatchId, reason });
  }

  async settleForeground(seed: CompletionDispatchSeed) {
    this.foreground.push(seed.dispatchId);
  }
}

const admission = (coordinator: FakeCoordinator) => ParallelCompletionController.admit<string>({
  parentDispatchId: "parent",
  taskCorrelationIds: ["task-a", "task-b"],
  target: { workspaceId: "workspace", sessionId: "session" },
  replyTarget: "caller",
  originCwd: "D:/repo",
  coordinator,
  createdAt: 123,
  reservationId: (() => {
    let index = 0;
    return () => `reservation-${++index}`;
  })(),
});

test("parallel completion admits exact singleton child seeds in one delivery group", async () => {
  const coordinator = new FakeCoordinator([true, true]);
  const controller = await admission(coordinator);

  assert.equal(controller.durable, true);
  assert.deepEqual(coordinator.began.map((seed) => ({
    dispatchId: seed.dispatchId,
    deliveryGroupId: seed.deliveryGroupId,
    reservationId: seed.reservationId,
    mode: seed.mode,
    expectedTasks: seed.expectedTasks,
    createdAt: seed.createdAt,
  })), [
    {
      dispatchId: "task-a",
      deliveryGroupId: "parent",
      reservationId: "reservation-1",
      mode: "parallel",
      expectedTasks: ["task-a"],
      createdAt: 123,
    },
    {
      dispatchId: "task-b",
      deliveryGroupId: "parent",
      reservationId: "reservation-2",
      mode: "parallel",
      expectedTasks: ["task-b"],
      createdAt: 123,
    },
  ]);
  assert.deepEqual(controller.completionIdentity("task-a"), {
    dispatchId: "task-a",
    reservationId: "reservation-1",
  });
});

test("parallel completion rolls back admitted seeds when durability changes during admission", async () => {
  const coordinator = new FakeCoordinator([true, false]);
  await assert.rejects(admission(coordinator), /durability changed/);
  assert.deepEqual(coordinator.abandoned.map((entry) => entry.dispatchId), ["task-a"]);

  const reverse = new FakeCoordinator([false, true]);
  await assert.rejects(admission(reverse), /durability changed/);
  assert.deepEqual(reverse.abandoned.map((entry) => entry.dispatchId), ["task-b"]);
});

test("parallel completion buffers foreground publications and flushes each result once after activation", async () => {
  const coordinator = new FakeCoordinator([true, true]);
  const controller = await admission(coordinator);

  assert.equal(controller.record("task-a", "A", false), undefined);
  assert.equal(controller.record("task-a", "A duplicate", false), undefined);
  assert.deepEqual(controller.snapshot(), { total: 2, ready: 1, failed: 0, remaining: 1 });

  const first = await controller.activateNotifications();
  assert.equal(first.length, 1);
  assert.equal(first[0]?.correlationId, "task-a");
  assert.deepEqual(first[0]?.snapshot, { total: 2, ready: 1, failed: 0, remaining: 1 });
  assert.deepEqual(coordinator.required, [
    { dispatchId: "task-a", kind: "single" },
    { dispatchId: "task-b", kind: "single" },
  ]);

  assert.deepEqual(await controller.activateNotifications(), []);
  assert.equal(controller.retry("task-a"), undefined, "in-flight delivery cannot be claimed twice");
  controller.finishDelivery("task-a", true);
  assert.equal(controller.retry("task-a"), undefined, "delivered result cannot be claimed again");

  const second = controller.record("task-b", "B failed", true);
  assert.equal(second?.correlationId, "task-b");
  assert.deepEqual(second?.snapshot, { total: 2, ready: 2, failed: 1, remaining: 0 });
  controller.finishDelivery("task-b", false);
  assert.equal(controller.retry("task-b")?.correlationId, "task-b", "failed delivery can retry with the same publication");
});

test("parallel completion foreground settlement fences later notification activation", async () => {
  const coordinator = new FakeCoordinator([true, true]);
  const controller = await admission(coordinator);
  controller.record("task-a", "A", false);

  await controller.settleForeground();
  assert.deepEqual(coordinator.foreground, ["task-a", "task-b"]);
  assert.deepEqual(await controller.activateNotifications(), []);
  assert.equal(controller.record("task-b", "B", false), undefined);
});

test("parallel completion activation failure abandons every child and cannot settle as foreground", async () => {
  const coordinator = new FakeCoordinator([true, true]);
  const controller = await admission(coordinator);
  controller.record("task-a", "A", false);
  coordinator.rejectNotificationFor = "task-b";

  await assert.rejects(controller.activateNotifications(), /notification activation failed/);
  assert.deepEqual(coordinator.required.map((entry) => entry.dispatchId), ["task-a"]);
  assert.deepEqual(coordinator.abandoned.map((entry) => entry.dispatchId), ["task-a", "task-b"]);
  assert.equal(controller.state, "abandoned");
  assert.deepEqual(await controller.activateNotifications(), []);
  await controller.settleForeground();
  assert.deepEqual(coordinator.foreground, [], "the failed transition cannot return a foreground aggregate");
});

test("parallel completion accepts uniformly non-durable admission without synthetic identities", async () => {
  const coordinator = new FakeCoordinator([false, false]);
  const controller = await admission(coordinator);

  assert.equal(controller.durable, false);
  assert.equal(controller.completionIdentity("task-a"), undefined);
  controller.record("task-a", "A", false);
  assert.equal((await controller.activateNotifications())[0]?.value, "A");
  assert.deepEqual(coordinator.required, []);
});

test("parallel completion message is UTF-8 bounded and reports result-ready state", () => {
  const snapshot = { total: 4, ready: 2, failed: 1, remaining: 2 };
  const message = formatParallelCompletionMessage({
    label: "reviewer",
    correlationId: "task-a",
    resourceUri: "agent://publication-a",
    resultSummary: "界".repeat(2_000),
    snapshot,
    maxBytes: 512,
  });

  assert.ok(Buffer.byteLength(message, "utf8") <= 512);
  assert.match(message, /^@reviewer result ready · task-a\nagent:\/\/publication-a/);
  assert.match(message, /Parallel status: 2\/4 results ready · 1 failed · 2 remaining$/);
  assert.equal(formatParallelCompletionStatus(snapshot), "Parallel status: 2/4 results ready · 1 failed · 2 remaining");
});
