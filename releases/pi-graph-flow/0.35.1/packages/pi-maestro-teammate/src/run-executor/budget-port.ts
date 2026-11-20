import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type { TodoSourceScope } from "../runs/todo-source-context.ts";
import { getTeammateChildToolBroker } from "../runs/child-extensions.ts";
import { captureChildModelBudgetRequestOrigin, assertChildModelBudgetNone, readChildModelBudgetKind,
  prepareChildModelBudgetContext, reservePreparedChildModelBudgetRequest, acquirePreparedChildModelBudgetRequest, abandonNativeTaskBudgetBeforeMark, markNativeTaskBudgetAttempted,
  beginNativeTaskBudgetReceiptDrain, endNativeTaskBudgetReceiptDrain, retireNativeTaskBudgetSender, markNativeTaskBudgetMayHaveSent, recordNativeTaskBudgetUnknown,
  settleNativeTaskBudgetRequest, CHILD_MODEL_BUDGET_BROKER, type TaskDispatchRequest } from "../public/v1/task-dispatch-binding.ts";
import type { ChildTodoParentMetadata } from "../runs/child-parent-context.ts";
import { ChildBudgetJournal } from "./budget-journal.ts";

interface Terminal { messageDigest: string; usageDigest: string; provider: string; model: string; stopReason: string; }
interface Claim { request: object; nonce: string; marked: boolean; attempted?: boolean; abandoned?: boolean; senderRetired?: boolean; producer?: object; known?: { identity: string; fact: object }; terminal?: Terminal; }
export type ChildModelBudgetPort = NonNullable<ChildTodoParentMetadata["modelBudget"]> & {
  isReplayNeutralControl(message: Record<string, unknown>): boolean;
  observeSession(message: Record<string, unknown>): void;
  interceptFact(message: Record<string, unknown>, reply: (message: Record<string, unknown>) => void): boolean;
  close(): void;
};
/** Bound once by the actual attempt. Child JSON supplies neither identity nor amount. */
export function createChildModelBudgetPort(input: {
  child: ChildProcess; sourceScope?: TodoSourceScope; nativeGate?: object;
  originalDispatch?: { readonly origin: object | undefined; readonly request: TaskDispatchRequest };
  correlationId: string; runtimeGeneration: number | null; nativeInvocationId(): string | undefined;
  launch: { cwd: string; sessionDir?: string; resumeSessionFile?: string; forkSessionFile?: string };
  assertCurrent(): void; onFactError?(error: unknown): void;
}): ChildModelBudgetPort | undefined {
  if (!getTeammateChildToolBroker(CHILD_MODEL_BUDGET_BROKER)) return undefined;
  const invocation = input.nativeInvocationId(), journal = new ChildBudgetJournal(input.launch);
  let nonce: string | undefined, sessionGeneration = 0;
  const closed = new AbortController();
  let sdkLifetime = new AbortController();
  let origin: ReturnType<typeof captureChildModelBudgetRequestOrigin> | undefined, sourceError: unknown;
  try { origin = captureChildModelBudgetRequestOrigin(input.sourceScope, input.nativeGate, input.originalDispatch); } catch (error) { sourceError = error; }
  const seen = new Set<string>(), preparing = new Set<string>(), claims = new Map<string, Claim>();
  const current = () => {
    input.assertCurrent();
    if (!input.child.connected || input.child.exitCode !== null || input.child.signalCode !== null
      || !invocation || input.nativeInvocationId() !== invocation) throw new Error("Child model invocation is unavailable or changed");
    if (!origin) throw sourceError ?? new Error("Child parent budget source is unavailable");
    return origin;
  };
  const session = (presented: string) => {
    const source = current();
    if (!nonce || nonce !== presented) throw new Error("Child budget nonce is foreign or retired");
    return source;
  };
  const claim = (presented: string, key: string) => {
    const value = claims.get(key);
    if (!value || value.nonce !== presented || !invocation || input.nativeInvocationId() !== invocation) throw new Error("Child fact has no original request claim");
    return value;
  };
  const facts = (params: Record<string, string>) => {
    const value = claim(params.nonce, params.claim);
    if (params.op === "abandon") {
      if (Object.keys(params).sort().join(",") !== "claim,nonce,op" || value.attempted || value.marked) throw Error("No trusted unmarked child acquisition");
      value.abandoned = true; abandonNativeTaskBudgetBeforeMark(value.request); return;
    }
    if (params.op === "sender-retired") {
      if (Object.keys(params).sort().join(",") !== "claim,nonce,op" || value.abandoned) throw Error("Invalid original receipt sender retirement");
      value.senderRetired = true; value.attempted = true;
      try { return retireNativeTaskBudgetSender(value.request); }
      finally { if (value.producer) endNativeTaskBudgetReceiptDrain(value.producer); }
    }
    if (!value.marked) throw new Error("Unsent child claim cannot issue a usage fact");
    if (params.op === "producer-drained") {
      if (Object.keys(params).sort().join(",") !== "claim,nonce,op") throw Error("Invalid receipt producer drain");
      try { recordNativeTaskBudgetUnknown(value.request); }
      finally { if (value.producer) endNativeTaskBudgetReceiptDrain(value.producer); }
      return;
    }
    if (params.op === "terminal") {
      if (Object.keys(params).sort().join(",") !== "claim,messageDigest,model,nonce,op,provider,stopReason,usageDigest") throw new Error("Invalid child terminal evidence");
      const terminal = { messageDigest: params.messageDigest, usageDigest: params.usageDigest, provider: params.provider, model: params.model, stopReason: params.stopReason };
      if (value.terminal && JSON.stringify(value.terminal) !== JSON.stringify(terminal)) throw new Error("Child terminal identity changed");
      if (!value.senderRetired) value.producer ??= beginNativeTaskBudgetReceiptDrain(value.request);
      recordNativeTaskBudgetUnknown(value.request); value.terminal = terminal;
    } else {
      if (Object.keys(params).sort().join(",") !== "claim,digest,entryId,nonce,op" || !value.terminal) throw new Error("Invalid child durable fact evidence");
      const identity = `${params.entryId}:${params.digest}`;
      if (value.known) {
        if (value.known.identity !== identity) throw new Error("Child request already has a different usage fact");
        settleNativeTaskBudgetRequest(value.request, value.known.fact); return;
      }
      try {
        const fact = journal.fact(value.request, params.entryId, params.digest, value.terminal);
        if (fact) {
          settleNativeTaskBudgetRequest(value.request, fact);
          value.known = { identity, fact }; journal.release(value.request);
        }
      } finally { if (value.producer) endNativeTaskBudgetReceiptDrain(value.producer); }
    }
  };
  return {
    isReplayNeutralControl(message) {
      // This classifies only the fixed, side-effect-free control protocol of
      // this actual attempt. It never grants authority or executes the broker.
      if (message.type !== "teammate_proxy_request" || message.tool !== CHILD_MODEL_BUDGET_BROKER
        || message.correlationId !== input.correlationId
        || Object.keys(message).some(key => !["type", "tool", "requestId", "params", "correlationId"].includes(key))) return false;
      const id = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 128;
      const params = message.params;
      if (!id(message.requestId) || !params || typeof params !== "object" || Array.isArray(params)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(params))) return false;
      const keys = Object.keys(params).sort().join(","), values = params as Record<string, unknown>;
      return (keys === "op" && values.op === "open")
        || (keys === "nonce,op,requestId" && values.op === "authorize-none" && id(values.nonce) && id(values.requestId));
    },
    observeSession: message => {
      if (message.correlationId !== input.correlationId) throw new Error("Child session publisher has a foreign correlation identity");
      journal.observeReady(message);
    },
    async open() {
      sdkLifetime.abort(Error("Original child SDK source generation retired")); sdkLifetime = new AbortController();
      const generation = ++sessionGeneration;
      nonce = undefined;
      const source = current(), kind = readChildModelBudgetKind(source);
      if (kind === "none") await assertChildModelBudgetNone(source);
      current();
      if (generation !== sessionGeneration) throw new Error("Child SDK startup handshake was superseded");
      nonce = randomUUID(); seen.clear();
      return { nonce, kind, correlationId: input.correlationId, runtimeGeneration: input.runtimeGeneration, nativeInvocationId: invocation! };
    },
    async authorizeNone(presented, requestId) {
      const generation = sessionGeneration, source = session(presented);
      if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 128 || seen.has(requestId)) throw new Error("Child budget nonce/request identity is foreign or reused");
      await assertChildModelBudgetNone(source); session(presented);
      if (generation !== sessionGeneration || seen.has(requestId)) throw new Error("Child model request identity was already admitted");
      seen.add(requestId);
    },
    async prepare(presented, requestId, control) {
      const source = session(presented), generation = sessionGeneration, pendingKey = `${presented}:${requestId}`;
      if (!requestId.trim() || requestId.length > 128 || seen.has(requestId) || preparing.has(pendingKey)) throw new Error("Child request identity is foreign or reused");
      preparing.add(pendingKey);
      try {
        const prepared = await prepareChildModelBudgetContext(source);
        session(presented);
        if (generation !== sessionGeneration || seen.has(requestId)) throw new Error("Child preparation was superseded");
        const preflight = Object.freeze({}); journal.begin(preflight, randomUUID()); journal.release(preflight);
        const signal = control?.signal ? AbortSignal.any([closed.signal, sdkLifetime.signal, control.signal]) : AbortSignal.any([closed.signal, sdkLifetime.signal]);
        const current = () => { signal.throwIfAborted(); session(presented); if (generation !== sessionGeneration || seen.has(requestId)) throw Error("Child preparation was superseded"); };
        const request = await acquirePreparedChildModelBudgetRequest(prepared, randomUUID(), { signal, assertCurrent: current });
        try {
          current();
          // Capture the actual journal leaf AFTER the potentially long wait.
          const key = randomUUID(), cut = Object.freeze({}); journal.begin(cut, key); current();
          journal.bindRequest(cut, request); seen.add(requestId);
          claims.set(key, { request, nonce: presented, marked: false }); return { claim: key };
        } catch (error) { try { abandonNativeTaskBudgetBeforeMark(request); } catch {} throw error; }
      } finally { preparing.delete(pendingKey); }
    },
    async abandon(presented, key) {
      const value = claim(presented, key);
      if (value.attempted || value.marked) throw Error("Child mark was already attempted");
      value.abandoned = true; abandonNativeTaskBudgetBeforeMark(value.request);
    },
    async mark(presented, key, entryId, digest) {
      const value = claim(presented, key);
      if (value.abandoned || value.senderRetired) throw Error("Child acquisition was abandoned or its sender retired");
      value.attempted = true; markNativeTaskBudgetAttempted(value.request); session(presented);
      if (value.marked) throw new Error("Child physical request was already marked");
      journal.mark(value.request, entryId, digest);
      markNativeTaskBudgetMayHaveSent(value.request); value.marked = true;
    },
    interceptFact(message, reply) {
      if (message.type !== "teammate_proxy_request" || message.tool !== CHILD_MODEL_BUDGET_BROKER
        || !message.params || typeof message.params !== "object") return false;
      const params = message.params as Record<string, unknown>;
      if (params.op !== "terminal" && params.op !== "fact" && params.op !== "producer-drained" && params.op !== "abandon" && params.op !== "sender-retired") return false;
      // Never forwards generic tools or obtains send authority, even after cancellation.
      try {
        if (typeof message.requestId !== "string" || !Object.values(params).every(v => typeof v === "string")) throw new Error("Invalid child fact envelope");
        const retired = facts(params as Record<string, string>);
        reply({ type: "teammate_proxy_result", requestId: message.requestId, result: { content: [], details: params.op === "abandon" ? { abandoned: true } : params.op === "sender-retired" ? { senderRetired: true, recorded: retired?.recorded === true } : { recorded: true } } });
      } catch (error) {
        input.onFactError?.(error);
        reply({ type: "teammate_proxy_result", requestId: message.requestId,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: {} } });
      }
      return true;
    },
    close() {
      closed.abort(Error("Original child model port closed"));
      for (const value of claims.values()) if (!value.attempted && !value.marked) { try { value.abandoned = true; abandonNativeTaskBudgetBeforeMark(value.request); } catch (error) { input.onFactError?.(error); } }
      for (const value of claims.values()) if (value.producer) { try { endNativeTaskBudgetReceiptDrain(value.producer); } catch (error) { input.onFactError?.(error); } }
      for (const value of claims.values()) if (value.marked && !value.known) {
        try { recordNativeTaskBudgetUnknown(value.request); } catch (error) { input.onFactError?.(error); }
      }
    },
  };
}
