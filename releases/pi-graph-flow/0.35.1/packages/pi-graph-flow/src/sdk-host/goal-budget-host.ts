import { createHash, randomUUID } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import type { GoalBudgetScope, GoalBudgetSource } from "../goal-coordinator/budget-source.ts";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { hasMeasuredModelUsage, type ModelRequestBudgetHost } from "./model-request-gate.ts";
import { childModelReceiptDigests } from "pi-maestro-teammate/v1/task-dispatch-binding";

export interface GoalModelBudgetPort {
  acquire?(context: object, control: { signal?: AbortSignal; assertCurrent?: () => void }): Promise<object>;
  abandonBeforeMark?(request: object): void;
  markAttempted?(request: object): void;
  beginReceiptDrain?(request: object): object;
  endReceiptDrain?(producer: object): void;
  retireSender?(request: object): { recorded: boolean };
  prepare(scope: GoalBudgetScope): Promise<object>;
  reserve(context: object): object;
  mark(request: object): void;
  unknown(request: object): void;
  settle(request: object, fact: object): void;
}
interface Fact { request: object; manager: object; units: number; entryId: string; digest: string; }
const facts = new WeakMap<object, Fact>();
/** Only the real journal observer below issues these handles. DTOs never issue usage. */
export function readModelUsageFact(fact: object, request: object, manager: object): Readonly<Fact> {
  const value = facts.get(fact);
  if (!value || value.request !== request || value.manager !== manager) throw new Error("Unissued SDK post-append usage fact");
  return value;
}
export interface GoalBudgetHostPorts {
  readonly manager: object;
  assertCurrent(): void;
  /** Existing admitted receipt only; never used by capture/reserve/mark. */
  assertFactCurrent?(): void;
  capture(): GoalBudgetSource;
  assertNone(source: GoalBudgetSource): void;
  read(scope: GoalBudgetScope): { readonly poolScope: unknown; readonly goalEntry: unknown };
  budget(): GoalModelBudgetPort;
}
interface Selection { source: GoalBudgetSource; pin: string; }
interface Pending { finish(): void; request: object; message?: AssistantMessage; usage: AssistantMessage["usage"]; provider: string; model: string; }
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createGoalBudgetHost(ports: GoalBudgetHostPorts): ModelRequestBudgetHost & {
  observeAppend(name: string, args: readonly unknown[], result: unknown): void;
} {
  const selections = new WeakMap<object, Selection>();
  const tickets = new WeakMap<object, { request: object; budget: GoalModelBudgetPort }>();
  const pending = new Set<Pending>();
  const current = (): Selection => {
    ports.assertCurrent();
    const source = ports.capture();
    return { source, pin: source.kind === "none" ? "none" : digest(ports.read(source.scope)) };
  };
  return {
    capture() { const selection = current(), handle = Object.freeze({}); selections.set(handle, selection); return handle; },
    async beforePhysical(origin, operation = "stream", signal) {
      const original = selections.get(origin);
      if (!original) throw new Error("Unissued model request source");
      if (original.source.kind === "none") ports.assertNone(original.source);
      const selected = current();
      if (selected.pin !== original.pin) throw new Error("Model request Goal source changed before physical routing");
      if (selected.source.kind === "none") return undefined;
      if (operation === "image" || operation === "deferred") throw new Error(`Declared Goal budget does not support ${operation} token accounting; no request was reserved or sent`);
      // SDK1.4 deliberately leaves setup-only sessions in RAM. We cannot
      // promise a durable usage receipt there or manufacture a user message.
      const file: unknown = Reflect.apply(Reflect.get(ports.manager, "getSessionFile"), ports.manager, []);
      try { if (typeof file !== "string" || !lstatSync(file).isFile()) throw new Error("not durable"); }
      catch { throw new Error("当前会话尚未保存聊天记录，暂不能可靠记录用量；本次请求未发送。先发送一条普通消息后再试。"); }
      const budget = ports.budget();
      const context = await budget.prepare(selected.source.scope);
      ports.assertCurrent();
      if (current().pin !== selected.pin) throw new Error("Model request Goal source changed during reservation");
      const assertCurrent = () => { ports.assertCurrent(); if (current().pin !== selected.pin) throw Error("Model request Goal source changed while awaiting capacity"); };
      const request = budget.acquire ? await budget.acquire(context, { signal, assertCurrent }) : budget.reserve(context), ticket = Object.freeze({});
      try { signal?.throwIfAborted(); assertCurrent(); }
      catch (error) { try { budget.abandonBeforeMark?.(request); } catch {} throw error; }
      tickets.set(ticket, { request, budget });
      return ticket;
    },
    abandonBeforeMark(ticket) {
      const held = tickets.get(ticket); if (!held) throw Error("Unissued physical model request");
      if (!held.budget.abandonBeforeMark) throw Error("Unmarked acquisition revocation unavailable"); held.budget.abandonBeforeMark(held.request);
    },
    beforeDelegate(ticket) {
      const held = tickets.get(ticket);
      if (!held) throw new Error("Unissued physical model request");
      held.budget.markAttempted?.(held.request); ports.assertCurrent(); held.budget.mark(held.request);
    },
    onResult(ticket, message) {
      const held = tickets.get(ticket); if (!held) throw Error("Unissued physical model response");
      const producer = held.budget.beginReceiptDrain?.(held.request);
      const finish = () => { if (producer) held.budget.endReceiptDrain?.(producer); };
      let registered = false;
      try {
        held.budget.unknown(held.request);
        if ((message.stopReason === "error" || message.stopReason === "aborted") && !hasMeasuredModelUsage(message.usage)) return;
        pending.add({ finish, request: held.request, message, usage: message.usage, provider: message.provider, model: message.responseModel ?? message.model }); registered = true;
      } finally { if (!registered) finish(); }
    },
    onUsageResult(ticket, result, model) {
      const held = tickets.get(ticket); if (!held) throw Error("Unissued native model response");
      const producer = held.budget.beginReceiptDrain?.(held.request);
      const finish = () => { if (producer) held.budget.endReceiptDrain?.(producer); };
      let registered = false;
      try {
        held.budget.unknown(held.request);
        if (!result || typeof result !== "object" || !model || typeof model !== "object") return;
        const usage: unknown = Reflect.get(result, "usage"), reason = Reflect.get(result, "stopReason");
        if (!usage || typeof usage !== "object" || ((reason === "error" || reason === "aborted") && !hasMeasuredModelUsage(usage))) return;
        const provider: unknown = Reflect.get(model, "provider"), id: unknown = Reflect.get(model, "id");
        if (typeof provider !== "string" || typeof id !== "string") throw Error("Native usage has no original model identity");
        pending.add({ finish, request: held.request, usage: usage as AssistantMessage["usage"], provider, model: id }); registered = true;
      } finally { if (!registered) finish(); }
    },
    onAppendFailure(name, args) {
      for (const value of [...pending]) if (name === "appendMessage" ? value.message === args[0] : args[3] === value.usage) {
        pending.delete(value); value.finish();
      }
    },
    async drainMessages(messages) {
      for (const value of [...pending]) if (value.message && messages.includes(value.message)) { pending.delete(value); value.finish(); }
    },
    observeAppend(name, args, result) {
      if (ports.assertFactCurrent) ports.assertFactCurrent(); else ports.assertCurrent();
      const id = name === "appendMessage" ? result : (result && typeof result === "object" ? Reflect.get(result, "id") : undefined);
      if (typeof id !== "string") return;
      for (const value of pending) {
        const matches = name === "appendMessage" ? value.message !== undefined && args[0] === value.message
          : name === "appendUsage" && args[3] === value.usage && args[1] === value.provider && args[2] === value.model;
        if (!matches) continue;
        const manager = ports.manager;
        const entry: unknown = Reflect.apply(Reflect.get(manager, "getEntry"), manager, [id]);
        const file: unknown = Reflect.apply(Reflect.get(manager, "getSessionFile"), manager, []);
        if (!entry || typeof entry !== "object" || typeof file !== "string") throw new Error("SDK usage has no persistent original journal");
        const durable = readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as unknown)
          .find(row => row && typeof row === "object" && Reflect.get(row, "id") === id);
        if (!durable || digest(entry) !== digest(durable)) throw new Error("SDK usage journal entry is not durably appended");
        const usage = value.usage;
        const pieces = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
        const total = pieces.reduce((sum, n) => sum + n, 0);
        // Preserve the existing Goal budget unit: input + output tokens. Cached
        // buckets validate the provider total but do not change the budget unit.
        const units = usage.input + usage.output;
        if (!pieces.every(n => Number.isSafeInteger(n) && n >= 0) || !Number.isSafeInteger(units) || usage.totalTokens !== total) {
          throw new Error("SDK usage token evidence is incomplete; reservation remains held");
        }
        // SDK provider adapters initialize usage to all zero even if no usage
        // chunk is ever received. A successful done + append is not presence proof.
        // Positive cache evidence may legitimately settle zero input+output units.
        if (total === 0) { pending.delete(value); value.finish(); continue; }
        const fact = Object.freeze({});
        facts.set(fact, { request: value.request, manager, units, entryId: id, digest: digest(durable) });
        ports.budget().settle(value.request, fact);
        pending.delete(value); value.finish();
      }
    },
  };
}


/** The original Teammate proxy supplies the authenticated reply channel. */
export async function createChildBudgetHost(callParent: (input: Readonly<Record<string, string>>, signal?: AbortSignal) => Promise<unknown>, manager?: object): Promise<ModelRequestBudgetHost & {
  observeAppend(name: string, args: readonly unknown[], result: unknown): void;
  flush(): Promise<void>;
  retireTerminalProducers(): Promise<void>;
}> {
  const reply = await callParent({ op: "open" });
  if (!reply || typeof reply !== "object" || typeof Reflect.get(reply, "nonce") !== "string"
    || !Reflect.get(reply, "nonce") || typeof Reflect.get(reply, "nativeInvocationId") !== "string"
    || !["none", "declared"].includes(Reflect.get(reply, "kind"))) throw new Error("Parent model source handshake is invalid");
  const nonce = Reflect.get(reply, "nonce") as string, declared = Reflect.get(reply, "kind") === "declared";
  if (declared && !manager) throw new Error("Declared child budget requires the original SDK session manager");
  const origin = Object.freeze({});
  interface Ticket { claim?: string; intentId?: string; intentDigest?: string; attempted: boolean; consumed: boolean; retired?: boolean; }
  const tickets = new WeakMap<object, Ticket>(), pending = new Set<{ value: Ticket; message?: AssistantMessage; usage: unknown; provider: string; model: string }>();
  const writes = new Set<Promise<void>>(), failures: unknown[] = [];
  const active = new Set<Ticket>(); let closing = false;
  const accepted = (value: unknown, key: string) => {
    if (!value || typeof value !== "object" || Reflect.get(value, key) !== true) throw new Error(`Parent child budget ${key} failed`);
  };
  const getEntry = (id: string) => {
    if (!manager) throw new Error("Child original SDK manager is unavailable");
    const get = Reflect.get(manager, "getEntry");
    if (typeof get !== "function") throw new Error("Child original SDK journal reader is unavailable");
    const entry: unknown = Reflect.apply(get, manager, [id]);
    if (!entry || typeof entry !== "object") throw new Error("Child original SDK journal entry is unavailable");
    return entry;
  };
  const drained = async (value: Ticket) => {
    if (value.claim) accepted(await callParent({ op: "producer-drained", nonce, claim: value.claim }), "recorded");
    active.delete(value);
  };
  const trackDrain = (value: Ticket) => {
    const write = drained(value).catch(error => { failures.push(error); }).finally(() => writes.delete(write)); writes.add(write); return write;
  };
  return {
    capture: () => origin,
    async beforePhysical(source, operation = "stream", signal) {
      if (closing) throw Error("Original child receipt sender is retired");
      if (source !== origin) throw new Error("Child model source belongs to a different invocation");
      if (declared && (operation === "image" || operation === "deferred")) throw new Error(`Declared child budget does not support ${operation} token accounting; no parent reservation was requested`);
      if (declared) {
        const file: unknown = manager && typeof Reflect.get(manager, "getSessionFile") === "function" ? Reflect.apply(Reflect.get(manager, "getSessionFile"), manager, []) : undefined;
        try { if (typeof file !== "string" || !lstatSync(file).isFile()) throw Error("not durable"); }
        catch { throw new Error("Child budget cannot reliably persist usage before its first real conversation; no request was reserved or sent"); }
      }
      const value: Ticket = { attempted: false, consumed: false };
      if (!declared) {
        accepted(await callParent({ op: "authorize-none", nonce, requestId: randomUUID() }, signal), "authorized");
      } else {
        const prepared = await callParent({ op: "prepare", nonce, requestId: randomUUID() }, signal);
        const claim: unknown = prepared && typeof prepared === "object" ? Reflect.get(prepared, "claim") : undefined;
        if (typeof claim !== "string" || !claim) throw new Error("Parent child budget request claim is invalid");
        value.claim = claim;
        try {
          signal?.throwIfAborted();
          const append = Reflect.get(manager!, "appendCustomEntry");
          if (typeof append !== "function") throw new Error("Original child journal intent capability unavailable");
          const id: unknown = Reflect.apply(append, manager, ["pi-graph:child-model-request/1", { claim }]);
          if (typeof id !== "string") throw new Error("Original child request intent was not appended");
          value.intentId = id; value.intentDigest = digest(getEntry(id));
        } catch (error) { try { accepted(await callParent({ op: "abandon", nonce, claim }), "abandoned"); } catch {} throw error; }
      }
      const ticket = Object.freeze({}); tickets.set(ticket, value); if (value.claim) active.add(value); return ticket;
    },
    async abandonBeforeMark(ticket) {
      const value = tickets.get(ticket); if (!value || value.attempted) throw Error("Child mark was already attempted");
      value.attempted = true;
      if (value.claim) accepted(await callParent({ op: "abandon", nonce, claim: value.claim }), "abandoned");
      active.delete(value);
    },
    beforeDelegate(ticket) {
      const value = tickets.get(ticket);
      if (!value || value.attempted || value.retired || closing) throw new Error("Child physical model ticket is foreign, retired or already consumed");
      value.attempted = true;
      if (!value.claim) { value.consumed = true; return; }
      return callParent({ op: "mark", nonce, claim: value.claim, entryId: value.intentId!, digest: value.intentDigest! })
        .then(reply => { accepted(reply, "marked"); value.consumed = true; });
    },
    onResult(ticket, message) {
      const value = tickets.get(ticket); if (!value?.consumed) throw Error("Child model terminal has no admitted physical ticket");
      const claim = value.claim; if (!claim) return;
      return (async () => {
      try {
        const receipt = childModelReceiptDigests(message);
        accepted(await callParent({ op: "terminal", nonce, claim, ...receipt,
          provider: message.provider, model: message.responseModel ?? message.model, stopReason: message.stopReason }), "recorded");
        if ((message.stopReason !== "error" && message.stopReason !== "aborted") || hasMeasuredModelUsage(message.usage)) pending.add({ value, message, usage: message.usage, provider: message.provider, model: message.responseModel ?? message.model });
        else await drained(value);
      } catch (error) { try { await drained(value); } catch {} throw error; }
      })();
    },
    onUsageResult(ticket, result, model) {
      const value = tickets.get(ticket); if (!value?.consumed) throw Error("Child classifier terminal has no admitted physical ticket");
      const claim = value.claim; if (!claim) return;
      return (async () => {
      try {
        const response = result && typeof result === "object" ? result : {}, selected = model && typeof model === "object" ? model : {};
        const provider: unknown = Reflect.get(selected, "provider"), id: unknown = Reflect.get(selected, "id"), usage: unknown = Reflect.get(response, "usage");
        const stopReason = Reflect.get(response, "stopReason") === "stop" ? "stop" : Reflect.get(response, "stopReason") === "aborted" ? "aborted" : "error";
        if (typeof provider !== "string" || typeof id !== "string") throw Error("Child classifier original model identity unavailable");
        accepted(await callParent({ op: "terminal", nonce, claim, ...childModelReceiptDigests(response), provider, model: id, stopReason }), "recorded");
        if (usage && typeof usage === "object" && (stopReason === "stop" || hasMeasuredModelUsage(usage))) pending.add({ value, usage, provider, model: id });
        else await drained(value);
      } catch (error) { try { await drained(value); } catch {} throw error; }
      })();
    },
    onAppendFailure(name, args) {
      for (const item of [...pending]) if (name === "appendMessage" ? item.message === args[0] : item.usage === args[3]) { pending.delete(item); void trackDrain(item.value); }
    },
    async drainMessages(messages) {
      for (const item of [...pending]) if (item.message && messages.includes(item.message)) { pending.delete(item); void trackDrain(item.value); }
      await Promise.all(writes);
    },
    observeAppend(name, args, result) {
      const id = name === "appendMessage" ? result : (result && typeof result === "object" ? Reflect.get(result, "id") : undefined);
      if (typeof id !== "string") return;
      for (const item of pending) {
        const matches = name === "appendMessage" ? item.message !== undefined && args[0] === item.message
          : name === "appendUsage" && args[3] === item.usage && args[1] === item.provider && args[2] === item.model;
        if (!matches) continue;
        pending.delete(item);
        const entryDigest = digest(getEntry(id));
        const write = callParent({ op: "fact", nonce, claim: item.value.claim!, entryId: id, digest: entryDigest })
          .then(reply => { accepted(reply, "recorded"); active.delete(item.value); }).catch(error => { failures.push(error); }).finally(() => { writes.delete(write); });
        writes.add(write);
      }
    },
    async retireTerminalProducers() {
      // The exact transport lifetime is closing; this says nothing about physical completion.
      closing = true;
      for (const value of [...active]) {
        value.retired = true;
        const op = value.attempted ? "sender-retired" : "abandon";
        const write = callParent({ op, nonce, claim: value.claim! })
          .then(reply => { accepted(reply, op === "abandon" ? "abandoned" : "senderRetired"); active.delete(value); })
          .catch(error => { failures.push(error); }).finally(() => writes.delete(write));
        writes.add(write);
      }
      await Promise.all(writes);
      if (failures.length) throw new AggregateError(failures, "Child receipt retirement remains unknown");
    },
    async flush() {
      // Active flush waits only already-sent writes. A later producer must not
      // be retired by an earlier turn's flush.
      await Promise.all(writes);
      if (failures.length) throw new AggregateError(failures, "Child post-append budget facts remain unknown");
    },
  };
}
