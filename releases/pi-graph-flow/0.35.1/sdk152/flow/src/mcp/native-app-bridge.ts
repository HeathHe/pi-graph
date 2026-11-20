/** Native App adapter. The original factory/client remain the only MCP owners.
 * No request is manufactured here: only original transport sends are admitted/decorated.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Type, type TSchema } from "typebox";
import { runToolCall, type AgentToolCall, type AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  createMcpExtension, type AgentSession, type ExtensionAPI, type ExtensionFactory,
  type McpExtensionOptions, type McpTransportFactory, type ToolDefinition, type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  isJsonRpcRequest, isJsonRpcResponse, type JsonRpcId, type JsonRpcMessage,
  type McpTransport, type McpTransportSendOptions, type JsonRpcErrorObject,
} from "@earendil-works/pi-mcp";
import {
  CallToolResultSchema, ListToolsResultSchema, ListResourcesResultSchema, ReadResourceResultSchema,
  type CallToolResult, type ReadResourceResult, type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ConsentManager } from "./consent-manager.ts";
import type { NativeAppOperationPort } from "./native-app-port.ts";
import { parseUiResourceResult, UiPresentationError } from "./ui-resource-handler.ts";
import { startUiServer, type UiServerHandle } from "./ui-server.ts";
import { onUiSessionMessage, onUiSessionContext, retainCompletedUiSession, executeUiMessages, type UiSessionPolicyHost, type UiViewerContext, type UiViewerHandle } from "./ui-session-policy.ts";
import type { CompletedUiSession } from "./state.ts";
import { withStreamEnvelope } from "./ui-session.ts";
import { extractToolUiStreamMode } from "./utils.ts";
import {
  UI_STREAM_HOST_CONTEXT_KEY, UI_STREAM_REQUEST_META_KEY,
  serverStreamResultPatchNotificationSchema,
} from "./ui-stream-types.ts";

/** Structural subset implemented by the actual M18 HostSessionScope.begin result. */
export interface NativeHostOperation {
  readonly session: AgentSession;
  readonly generation: object;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  finish(): void;
  cancel(): void;
}
export interface NativeAppHost {
  begin(signal?: AbortSignal): NativeHostOperation;
}
export interface NativeAppBridgeOptions {
  host: NativeAppHost;
  consentManager: ConsentManager;
  /** The original SDK default transport factory, or the caller's original explicit factory. */
  createTransport: McpTransportFactory;
  mcp?: Omit<McpExtensionOptions, "createTransport">;
  /** Trusted viewer policy; receives an already bound original UiServer URL. */
  openUi(url: string, context: UiViewerContext): Promise<void | UiViewerHandle>;
  audit(event: { actor: "HostUserAction" | "HostResourceRead"; operationId: string; nativeName: string }): void;
  diagnostic(error: unknown): void;
}
interface Publication {
  readonly definition: Pick<ToolDefinition, "name" | "label" | "namespace" | "exposure">;
  readonly server?: string;
  readonly rawName?: string;
  readonly transport?: TransportState;
  readonly descriptor?: Tool;
  live: boolean;
}
interface Binding {
  readonly host: NativeHostOperation;
  readonly publication: Publication;
  readonly transport: TransportState;
  readonly uri: string;
  readonly controller: AbortController;
  readonly operations: Map<string, Operation>;
  readonly streams: Set<StreamLease>;
  initialStreamToken?: string;
  initialContextToken?: string;
  uiFailure?: Error;
  uiFatal?: { error: unknown };
  opening?: OpeningAttempt;
  uiState: "unopened" | "preparing" | "ready" | "unavailable" | "retired";
  uiFailureClosing: boolean;
  admissionSequence: number;
  completed: boolean;
  live: boolean;
  handle?: UiServerHandle;
  viewer?: UiViewerHandle;
}
interface Operation {
  readonly id: string;
  readonly origin: "model" | "app" | "preparation";
  failure?: { kind: "wire-response"; error: JsonRpcErrorObject } | { kind: "wire-send"; error: unknown };
  readonly host: NativeHostOperation;
  readonly publication: Publication;
  readonly kind: "call" | "read" | "list";
  readonly binding: Binding;
  readonly uri?: string;
  readonly streamToken: string;
  readonly streamId: string | undefined;
  readonly sourceSignal?: AbortSignal;
  lease?: StreamLease;
  raw?: unknown;
  sent: boolean;
  answered: boolean;
  live: boolean;
}
/** UI-only lifetime. No tool context, business execution, usage or dispatch capability. */
interface StreamLease {
  readonly binding: Binding;
  readonly publication: Publication;
  readonly transport: TransportState;
  readonly token: string;
  readonly streamId: string | undefined;
  sequence: number;
  admission?: number;
  responded: boolean;
  finished: boolean;
  model: boolean;
  live: boolean;
  detach(): void;
}
type UiPreparationOutcome = { kind: "ready" } | { kind: "unavailable"; error: Error };
interface OpeningWaiter { readonly op: Operation; readonly args: Record<string, unknown>; readonly sendOptions?: McpTransportSendOptions }
interface OpeningAttempt {
  readonly controller: AbortController;
  readonly waiters: Map<Operation, OpeningWaiter>;
  promise?: Promise<UiPreparationOutcome>;
  settled: boolean;
}
function ordinaryListenFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause: unknown = error.cause;
  const codes = ["code" in error ? error.code : undefined, cause instanceof Error && "code" in cause ? cause.code : undefined];
  if (codes.some(code => code === "EACCES" || code === "EPERM")) return false;
  return codes.some(code => code === "EADDRINUSE" || code === "EADDRNOTAVAIL" || code === "EMFILE" || code === "ENFILE");
}
interface Execution {
  readonly publication: Publication;
  readonly toolCallId: string;
  readonly signal: AbortSignal | undefined;
  readonly context: ExtensionToolContext;
  operation?: Operation;
}
interface Pending {
  readonly method: string;
  readonly operation?: Operation;
  readonly listCursor?: unknown;
  detach(): void;
}
interface TransportState {
  readonly server: string;
  readonly epoch: object;
  readonly transport: McpTransport;
  readonly pending: Map<JsonRpcId, Pending>;
  readonly descriptors: Map<string, Tool>;
  readonly resources: Map<string, Record<string, unknown> | undefined>;
  live: boolean;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function uiUri(tool: Tool | undefined): string | undefined {
  if (!tool) return undefined;
  try { return getToolUiResourceUri(tool); } catch { return undefined; }
}
/** Validate without coercion, getters, serialization, copying or dropping fields. */
function isToolCallArguments(value: unknown): value is AgentToolCall["arguments"] {
  const active = new WeakSet<object>();
  const visit = (item: unknown): boolean => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || active.has(item)) return false;
    const array = Array.isArray(item);
    const prototype: unknown = Object.getPrototypeOf(item);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return false;
    active.add(item);
    try {
      const keys = Reflect.ownKeys(item);
      if (array && keys.length !== item.length + 1) return false; // reject holes/extra keys
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") return false;
        if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
        const child: unknown = descriptor.value;
        if (!visit(child)) return false;
      }
      return true;
    } finally { active.delete(item); }
  };
  try { return record(value) && visit(value); }
  catch { return false; } // includes hostile reflection traps / excessive recursive depth
}

function technicalMessage(call: AgentToolCall): AssistantMessage {
  // Required public runToolCall container only. Never appended to a session or emitted as an event.
  return {
    role: "assistant", content: [call], api: "host-user-action", provider: "HostUserAction",
    model: "HostUserAction", stopReason: "toolUse", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function createNativeAppBridge(options: NativeAppBridgeOptions): {
  factory: ExtensionFactory;
  close(): void;
  getCompletedUiSessions(): readonly CompletedUiSession[];
} {
  const report = (error: unknown) => { try { options.diagnostic(error); } catch { /* Diagnostics cannot suppress SDK delivery/cleanup. */ } };
  const executions = new AsyncLocalStorage<Execution>();
  const dispatches = new AsyncLocalStorage<Operation>();
  const publications = new Map<string, Publication>();
  const transports = new Set<TransportState>();
  const bindings = new Set<Binding>();
  const streams = new Map<string, StreamLease>();
  const history: Pick<UiSessionPolicyHost, "completedUiSessions"> = { completedUiSessions: [] };
  let activeBinding: Binding | undefined;
  let factoryApi: ExtensionAPI | undefined;

  function assertAuthority(binding: Binding): void {
    binding.controller.signal.throwIfAborted();
    binding.host.assertCurrent();
    const p = binding.publication;
    if (!binding.live || !binding.transport.live || !p.live || publications.get(p.definition.name) !== p ||
        p.transport !== binding.transport || uiUri(p.descriptor) !== binding.uri ||
        binding.transport.descriptors.get(p.rawName ?? "") !== p.descriptor) throw new Error("Stale native App binding");
  }
  function assertBinding(binding: Binding): void {
    assertAuthority(binding);
    if (binding.uiState === "unavailable" || binding.uiState === "retired") throw new Error("Native UI is unavailable");
  }
  function assertOperation(op: Operation, sendOptions?: McpTransportSendOptions): void {
    op.host.assertCurrent();
    assertAuthority(op.binding);
    if (op.origin !== "model") assertBinding(op.binding);
    op.sourceSignal?.throwIfAborted();
    sendOptions?.signal?.throwIfAborted();
    if (!op.live || !op.publication.live || publications.get(op.publication.definition.name) !== op.publication ||
        op.host.generation !== op.binding.host.generation || op.host.session !== op.binding.host.session) {
      throw new Error("Stale native App operation");
    }
  }
  function dropStream(lease: StreamLease): void {
    if (!lease.live) return;
    lease.live = false;
    streams.delete(lease.token);
    lease.binding.streams.delete(lease);
    lease.detach();
  }
  function reconcileInitial(binding: Binding, requireContext = false): void {
    const candidates = [...binding.streams].filter(lease => lease.live && lease.model && lease.admission !== undefined)
      .sort((a, b) => (a.admission ?? 0) - (b.admission ?? 0));
    const initial = candidates[0];
    binding.initialStreamToken = initial?.token;
    if (!initial) binding.initialContextToken = undefined;
    else if (binding.initialContextToken !== initial.token) {
      try {
        assertStream(initial);
        const mode = extractToolUiStreamMode(initial.publication.descriptor?._meta);
        if (!mode || !initial.streamId || !binding.handle) throw new Error("Initial UI stream context is unavailable");
        binding.handle.sendHostContext({ [UI_STREAM_HOST_CONTEXT_KEY]: {
          mode, streamId: initial.streamId, intermediateResultPatches: mode === "stream-first", partialInput: false,
        } });
        // sendHostContext updates the original cache and notifies listeners; reentrant close/cancel must win.
        assertStream(initial);
        if (binding.initialStreamToken !== initial.token) throw new Error("Initial UI stream changed during context notification");
        binding.initialContextToken = initial.token;
      } catch (error) { if (requireContext) throw error; report(error); }
    }
    if (initial?.responded) for (const lease of candidates.slice(1)) if (lease.finished) dropStream(lease);
  }
  function revokeStream(lease: StreamLease): void { dropStream(lease); reconcileInitial(lease.binding); }
  function assertStream(lease: StreamLease): void {
    assertBinding(lease.binding);
    if (!lease.live || lease.transport !== lease.binding.transport || !lease.transport.live ||
        !lease.publication.live || publications.get(lease.publication.definition.name) !== lease.publication ||
        lease.publication.transport !== lease.transport ||
        lease.transport.descriptors.get(lease.publication.rawName ?? "") !== lease.publication.descriptor) {
      throw new Error("Retired native UI-only stream lease");
    }
  }
  function streamLease(op: Operation): StreamLease {
    if (op.lease) return op.lease;
    assertOperation(op);
    const lease: StreamLease = { binding: op.binding, publication: op.publication, transport: op.binding.transport,
      token: op.streamToken, streamId: op.streamId, sequence: 0, responded: false, finished: false, model: op.origin === "model", live: true, detach: () => {} };
    const sourceSignal = op.sourceSignal;
    const abort = () => revokeStream(lease);
    sourceSignal?.addEventListener("abort", abort, { once: true });
    lease.detach = () => sourceSignal?.removeEventListener("abort", abort);
    if (sourceSignal?.aborted) { lease.live = false; lease.detach(); throw new Error("Cancelled UI stream"); }
    op.binding.streams.add(lease);
    streams.set(lease.token, lease);
    op.lease = lease;
    return lease;
  }
  function policyHost(binding: Binding): UiSessionPolicyHost {
    assertBinding(binding);
    const api = factoryApi;
    if (!api) throw new Error("Native factory API is unavailable");
    return {
      completedUiSessions: history.completedUiSessions,
      sendMessage(message, sendOptions) {
        assertBinding(binding);
        // Original legacy display string was truthy; SDK 1.4 explicitly requires boolean.
        api.sendMessage({ ...message, display: Boolean(message.display) }, sendOptions);
      },
      ui: { notify(message, type) {
        assertBinding(binding);
        const context = binding.host.session.extensionRunner.createContext();
        assertBinding(binding);
        context.ui.notify(message, type);
      } },
    };
  }
  function complete(binding: Binding, reason: string): void {
    if (binding.uiFailureClosing) return; // Trusted internal UI-only cleanup, never an HTTP reason bypass.
    if (binding.completed) return;
    binding.completed = true;
    const handle = binding.handle;
    if (handle && activeBinding === binding) {
      // Bookkeeping remains valid after fence; this is not a dispatch/message grant.
      retainCompletedUiSession(history, handle, reason);
    }
    if (activeBinding === binding) activeBinding = undefined;
    if (binding.viewer) {
      const viewer = binding.viewer; binding.viewer = undefined;
      try { viewer.close(); } catch (error) { report(error); }
    }
    retire(binding, reason);
  }
  function finish(op: Operation): void {
    if (!op.live) return;
    op.live = false;
    if (op.lease) {
      op.lease.finished = true;
      if (op.origin !== "model" || op.lease.admission === undefined) revokeStream(op.lease);
      else reconcileInitial(op.binding);
    }
    op.binding.operations.delete(op.id);
    op.host.finish();
    if (op.binding.uiState === "unavailable" && op.binding.operations.size === 0) retire(op.binding, "ui-unavailable-settled");
    // A native definition may settle before it ever sends or starts optional UI preparation.
    // Reclaim only a completely empty anchor; ready Apps and other callers retain their lifetime.
    const binding = op.binding;
    if (binding.uiState === "unopened" && binding.operations.size === 0 && !binding.opening &&
        !binding.handle && !binding.viewer && binding.streams.size === 0 && binding.initialStreamToken === undefined) {
      retire(binding, "unopened-without-operations");
    }
  }
  function unavailableUi(binding: Binding): void {
    if (!binding.live || binding.uiState === "unavailable" || binding.uiState === "retired") return;
    binding.uiState = "unavailable";
    if (activeBinding === binding) activeBinding = undefined;
    for (const lease of [...binding.streams]) dropStream(lease);
    binding.initialStreamToken = undefined;
    binding.initialContextToken = undefined;
    for (const op of [...binding.operations.values()]) if (op.origin !== "model") { op.host.cancel(); finish(op); }
    binding.opening?.controller.abort();
    const handle = binding.handle; binding.handle = undefined;
    const viewer = binding.viewer; binding.viewer = undefined;
    binding.uiFailureClosing = true;
    try { handle?.close("ui-unavailable"); } catch (error) { report(error); }
    try { viewer?.close(); } catch (error) { report(error); }
  }
  function retire(binding: Binding, reason = "native-binding-retired"): void {
    if (!binding.live) return;
    binding.uiState = "retired";
    binding.opening?.controller.abort();
    binding.live = false; // Revoke all admission before any callback/abort can re-enter.
    for (const lease of binding.streams) revokeStream(lease);
    for (const op of binding.operations.values()) op.live = false;
    for (const op of binding.operations.values()) {
      if (op.lease) revokeStream(op.lease);
      op.host.cancel();
    }
    binding.operations.clear();
    binding.controller.abort();
    binding.host.cancel();
    bindings.delete(binding);
    try { binding.handle?.close(reason); } catch (error) { report(error); }
    complete(binding, reason);
  }
  function revokePublication(p: Publication): void {
    p.live = false;
    for (const binding of bindings) {
      if (binding.publication === p || [...binding.operations.values()].some(op => op.publication === p) ||
          [...binding.streams].some(lease => lease.publication === p)) retire(binding);
    }
  }
  function retireTransport(state: TransportState): void {
    state.live = false;
    for (const binding of bindings) if (binding.transport === state) retire(binding);
    for (const pending of state.pending.values()) pending.detach();
    state.pending.clear(); state.descriptors.clear(); state.resources.clear();
  }
  function createBinding(p: Publication, parent: NativeHostOperation): Binding {
    for (const existing of bindings) {
      if (existing.uiState !== "unavailable" && existing.uiState !== "retired" && existing.publication === p && existing.host.generation === parent.generation && existing.host.session === parent.session) {
        assertBinding(existing);
        return existing; // Original same-server/tool reuse, additionally fenced by native identity.
      }
    }
    if (!p.transport || !p.rawName || !p.descriptor) throw new Error("No exact native App descriptor");
    const uri = uiUri(p.descriptor);
    if (!uri) throw new Error("No native App resource URI");
    const host = options.host.begin();
    if (host.generation !== parent.generation || host.session !== parent.session) {
      host.cancel(); throw new Error("Host changed before native App admission");
    }
    const binding: Binding = { host, publication: p, transport: p.transport, uri,
      controller: new AbortController(), operations: new Map(), streams: new Set(), completed: false, live: true, uiState: "unopened", uiFailureClosing: false, admissionSequence: 0 };
    bindings.add(binding);
    host.signal.addEventListener("abort", () => retire(binding), { once: true });
    assertBinding(binding);
    return binding;
  }
  function createOperation(binding: Binding, p: Publication, kind: Operation["kind"], signal?: AbortSignal, uri?: string, origin: Operation["origin"] = "app"): Operation {
    assertBinding(binding);
    const host = options.host.begin(signal);
    const op: Operation = { id: randomUUID(), origin, host, publication: p, binding, kind, uri,
      streamToken: randomUUID(), streamId: extractToolUiStreamMode(binding.publication.descriptor?._meta) ? randomUUID() : undefined, sourceSignal: signal, sent: false, answered: false, live: true };
    binding.operations.set(op.id, op);
    try { assertOperation(op); } catch (error) { finish(op); throw error; }
    return op;
  }
  function resourcePublication(name: "read_mcp_resource" | "list_mcp_resources" = "read_mcp_resource"): Publication {
    // This fixed SDK definition is observed at real registerTool, never synthesized.
    const p = publications.get(name);
    if (!p || p.definition.label !== name || p.definition.exposure === "hidden" || !p.live) {
      throw new Error("Native resource reader is unavailable");
    }
    return p;
  }
  async function dispatch(op: Operation, args: Record<string, unknown>, actor: "HostUserAction" | "HostResourceRead"): Promise<AgentToolCallOutcome> {
    assertOperation(op);
    const session = op.host.session;
    const runner = session.extensionRunner;
    const tools = runner.createToolContext(op.id, op.host.signal).tools;
    assertOperation(op);
    if (session.extensionRunner !== runner || !tools.some(tool => tool.name === op.publication.definition.name)) {
      throw new Error("Actual native tool is not callable");
    }
    if (!isToolCallArguments(args)) throw new Error("Native App arguments must be a JSON object without unsupported values or cycles");
    const call: AgentToolCall = { type: "toolCall", id: op.id, name: op.publication.definition.name, arguments: args };
    options.audit({ actor, operationId: op.id, nativeName: call.name });
    assertOperation(op);
    const result = await dispatches.run(op, () => runToolCall(call, {
      tools, assistantMessage: technicalMessage(call), context: { messages: session.agent.state.messages, tools: [...tools] },
      signal: op.host.signal,
      beforeToolCall: session.agent.beforeToolCall,
      afterToolCall: session.agent.afterToolCall,
    }));
    assertOperation(op);
    if (session.extensionRunner !== runner) throw new Error("Actual runner changed during native dispatch");
    if (result.isError && op.failure) throw op.failure.error;
    if (result.isError) throw new Error(result.result.content.filter(item => item.type === "text").map(item => item.text).join("\n") || "Native pipeline rejected operation");
    return result;
  }
  async function listResourceMetadata(binding: Binding, signal: AbortSignal): Promise<void> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      signal.throwIfAborted(); assertBinding(binding);
      const op = createOperation(binding, resourcePublication("list_mcp_resources"), "list", signal, undefined, "preparation");
      try {
        await dispatch(op, { server: binding.transport.server, ...(cursor === undefined ? {} : { cursor }) }, "HostResourceRead");
        assertOperation(op);
        const page = ListResourcesResultSchema.parse(op.raw);
        if (page.resources.some(resource => resource.uri === binding.uri)) return;
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (seen.has(cursor)) throw new Error("Native resource listing repeated its cursor");
          seen.add(cursor);
        }
      } finally { finish(op); }
    } while (cursor !== undefined);
  }
  async function read(binding: Binding, uri: string, signal?: AbortSignal, origin: Operation["origin"] = "app"): Promise<ReadResourceResult> {
    if (uri !== binding.uri) throw new Error("App resource URI mismatch");
    const op = createOperation(binding, resourcePublication(), "read", signal, uri, origin);
    try {
      await dispatch(op, { server: binding.transport.server, uri }, "HostResourceRead");
      assertOperation(op);
      return ReadResourceResultSchema.parse(op.raw);
    } finally { finish(op); }
  }
  function assertPort(binding: Binding): void {
    assertBinding(binding);
    if (binding.uiState !== "ready" || (binding.opening && !binding.opening.settled)) throw new Error("Native UI is not ready");
  }
  function port(binding: Binding): NativeAppOperationPort {
    return {
      current() { try { assertBinding(binding); return binding.uiState === "ready"; } catch { return false; } },
      async call(input, signal) {
        assertPort(binding);
        // Real raw name, same server and exact transport; no generic Goal/Task dispatcher.
        const candidates = [...publications.values()].filter(p => p.live && p.rawName === input.name &&
          p.transport === binding.transport && p.server === binding.transport.server && p.definition.exposure !== "hidden");
        if (candidates.length !== 1) throw new Error("App target is not uniquely published on this transport");
        const p = candidates[0];
        const targetUri = uiUri(p.descriptor);
        if (targetUri && targetUri !== binding.uri) throw new Error("App target UI URI mismatch");
        const op = createOperation(binding, p, "call", signal);
        try {
          const outcome = await dispatch(op, input.arguments ?? {}, "HostUserAction");
          assertOperation(op);
          const visible = CallToolResultSchema.parse(outcome.result.structuredContent);
          const raw = CallToolResultSchema.parse(op.raw);
          return { ...visible, ...(raw._meta === undefined ? {} : { _meta: raw._meta }) };
        } catch (error) {
          if (op.sent && !op.answered) throw new Error("UNKNOWN: native request was sent; do not replay", { cause: error });
          throw error;
        } finally { finish(op); }
      },
      read(input, signal) { assertPort(binding); return read(binding, input.uri, signal); },
      cancel(operationId) {
        const op = binding.operations.get(operationId);
        if (op) { finish(op); op.host.cancel(); }
      },
    };
  }
  function currentWaiter(binding: Binding, attempt: OpeningAttempt): OpeningWaiter {
    assertBinding(binding); attempt.controller.signal.throwIfAborted();
    if (binding.opening !== attempt) throw new Error("Stale UI opening attempt");
    for (const waiter of attempt.waiters.values()) {
      try { assertOperation(waiter.op, waiter.sendOptions); return waiter; } catch { /* Each waiter receives its own original error. */ }
    }
    throw new Error("UI opening has no current waiter");
  }
  async function openAttempt(binding: Binding, attempt: OpeningAttempt): Promise<UiPreparationOutcome> {
    try {
      currentWaiter(binding, attempt);
      await listResourceMetadata(binding, attempt.controller.signal);
      currentWaiter(binding, attempt);
      const result = await read(binding, binding.uri, attempt.controller.signal, "preparation");
      currentWaiter(binding, attempt);
      if (result.contents.some(content => content.uri !== binding.uri)) throw new Error("Native UI returned a different resource URI");
      let resource: ReturnType<typeof parseUiResourceResult>;
      try { resource = parseUiResourceResult(binding.transport.server, binding.uri, result, binding.transport.resources.get(binding.uri)); }
      catch (error) {
        currentWaiter(binding, attempt);
        if (!(error instanceof UiPresentationError)) throw error;
        binding.uiFailure = error; unavailableUi(binding); return { kind: "unavailable", error };
      }
      const waiter = currentWaiter(binding, attempt);
      if (activeBinding && activeBinding !== binding) retire(activeBinding, "replaced");
      currentWaiter(binding, attempt);
      activeBinding = binding;
      const mode = extractToolUiStreamMode(binding.publication.descriptor?._meta);
      const request = { serverName: binding.transport.server, toolName: binding.publication.rawName ?? "" };
      let handle: UiServerHandle;
      try {
        handle = await startUiServer({ ...request, toolArgs: mode === "stream-first" ? {} : waiter.args,
          resource, nativeOperations: port(binding), consentManager: options.consentManager,
          hostContext: mode ? { [UI_STREAM_HOST_CONTEXT_KEY]: { mode, streamId: waiter.op.streamId,
            intermediateResultPatches: mode === "stream-first", partialInput: false } } : undefined,
          onMessage: params => { assertPort(binding); onUiSessionMessage(policyHost(binding), request, params); assertPort(binding); },
          onContextUpdate: params => { assertPort(binding); onUiSessionContext(request, params); assertPort(binding); },
          onComplete: reason => complete(binding, reason),
        });
      } catch (error) {
        currentWaiter(binding, attempt);
        if (!(error instanceof Error) || !ordinaryListenFailure(error)) throw error;
        binding.uiFailure = error; unavailableUi(binding); return { kind: "unavailable", error };
      }
      try { currentWaiter(binding, attempt); } catch (error) {
        binding.uiFailureClosing = true; handle.close("stale-before-publication"); throw error;
      }
      binding.handle = handle;
      binding.uiState = "ready";
      const viewer = await options.openUi(handle.url, { ...request,
        current: () => { try { assertBinding(binding); return true; } catch { return false; } },
        onClosed: () => { assertBinding(binding); handle.close("glimpse-closed"); },
        notify: (message, type) => { assertBinding(binding); policyHost(binding).ui?.notify(message, type); },
      });
      try { currentWaiter(binding, attempt); } catch (error) { if (viewer) viewer.close(); throw error; }
      if (viewer) binding.viewer = viewer;
      binding.uiState = "ready";
      return { kind: "ready" };
    } catch (error) { binding.uiFatal = { error }; unavailableUi(binding); throw error; }
    finally { attempt.settled = true; }
  }
  async function prepare(op: Operation, args: Record<string, unknown>, sendOptions?: McpTransportSendOptions): Promise<UiPreparationOutcome> {
    assertOperation(op, sendOptions);
    const binding = op.binding;
    if (binding.uiState === "unavailable") {
      if (binding.uiFailure && op.origin === "model") return { kind: "unavailable", error: binding.uiFailure };
      if (binding.uiFatal) throw binding.uiFatal.error;
      throw new Error("Native UI attempt already ended");
    }
    if (!binding.handle || binding.opening) {
      let attempt = binding.opening;
      if (!attempt) {
        attempt = { controller: new AbortController(), waiters: new Map(), settled: false };
        binding.opening = attempt; binding.uiState = "preparing";
      }
      attempt.waiters.set(op, { op, args, sendOptions });
      const ownedAttempt = attempt;
      if (!ownedAttempt.promise) ownedAttempt.promise = openAttempt(binding, ownedAttempt);
      const opening = ownedAttempt.promise;
      const outcome = await new Promise<UiPreparationOutcome>((resolve, reject) => {
        const signals = [...new Set([op.host.signal, sendOptions?.signal].filter((signal): signal is AbortSignal => signal !== undefined))];
        let done = false;
        const detach = () => {
          for (const signal of signals) signal.removeEventListener("abort", abort);
          ownedAttempt.waiters.delete(op);
          if (ownedAttempt.settled && ownedAttempt.waiters.size === 0 && binding.opening === ownedAttempt) binding.opening = undefined;
          if (!ownedAttempt.settled && ownedAttempt.waiters.size === 0) { ownedAttempt.controller.abort(); unavailableUi(binding); }
        };
        const abort = () => {
          if (done) return; done = true; detach();
          try { assertOperation(op, sendOptions); reject(new Error("UI waiter cancelled")); } catch (error) { reject(error); }
        };
        for (const signal of signals) signal.addEventListener("abort", abort, { once: true });
        if (signals.some(signal => signal.aborted)) { abort(); return; }
        void opening.then(value => { if (!done) { done = true; detach(); resolve(value); } }, error => { if (!done) { done = true; detach(); reject(error); } });
      });
      assertOperation(op, sendOptions);
      if (outcome.kind === "unavailable") {
        report(outcome.error);
        try {
          assertOperation(op, sendOptions);
          const context = op.host.session.extensionRunner.createContext();
          assertOperation(op, sendOptions);
          if (context.hasUI) context.ui.notify(`MCP UI unavailable: ${outcome.error.message}`, "warning");
        } catch (error) { report(error); }
        assertOperation(op, sendOptions);
        return outcome;
      }
    }
    assertBinding(binding);
    if (!binding.handle) throw new Error("Native UI handle is unavailable");
    binding.handle.sendToolInput(args);
    assertOperation(op, sendOptions);
    if (extractToolUiStreamMode(binding.publication.descriptor?._meta)) streamLease(op);
    return { kind: "ready" };
  }
  function observe(state: TransportState, message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const pending = state.pending.get(message.id);
      state.pending.delete(message.id);
      pending?.detach();
      if (!pending || !state.live) return;
      const op = pending.operation;
      if (op) {
        // This precedes the original listener, whose successful removePending aborts sendController.
        op.answered = true;
        try {
          assertOperation(op);
          if ("result" in message) { op.raw = message.result; if (op.lease) { op.lease.responded = true; reconcileInitial(op.binding); } }
          else { op.failure = { kind: "wire-response", error: message.error }; if (op.lease) revokeStream(op.lease); }
        } catch { return; /* retired UI cannot update shared metadata or learn late results */ }
      }
      if (!("result" in message)) return;
      if (pending.method === "tools/list") {
        const parsed = ListToolsResultSchema.safeParse(message.result);
        if (!parsed.success) return;
        if (pending.listCursor === undefined) {
          for (const p of publications.values()) if (p.transport === state) revokePublication(p);
          state.descriptors.clear();
        }
        for (const tool of parsed.data.tools) state.descriptors.set(tool.name, tool);
      }
      if (pending.method === "resources/list") {
        const parsed = ListResourcesResultSchema.safeParse(message.result);
        if (parsed.success) {
          if (pending.listCursor === undefined) state.resources.clear();
          for (const resource of parsed.data.resources) state.resources.set(resource.uri, resource._meta);
        }
      }
      return;
    }
    const patch = serverStreamResultPatchNotificationSchema.safeParse(message);
    if (!patch.success) return;
    const lease = streams.get(patch.data.params.streamToken);
    if (!lease || lease.transport !== state) return;
    try {
      assertStream(lease);
      const result = CallToolResultSchema.parse({ content: [], ...patch.data.params.result });
      lease.binding.handle?.sendResultPatch(withStreamEnvelope(result, lease.streamId, ++lease.sequence));
    } catch (error) { report(error); }
  }
  function wrapTransport(original: McpTransport, server: string): McpTransport {
    const state: TransportState = { server, epoch: Object.freeze({}), transport: original, pending: new Map(), descriptors: new Map(), resources: new Map(), live: true };
    transports.add(state);
    // Observation is registered before the client listener. Every original frame still reaches it.
    original.onMessage((message: JsonRpcMessage) => { try { observe(state, message); } catch (error) { report(error); } });
    original.onClose(() => { retireTransport(state); transports.delete(state); });
    const send: McpTransport["send"] = async (message: JsonRpcMessage, sendOptions?: McpTransportSendOptions) => {
      if (!isJsonRpcRequest(message)) return original.send(message, sendOptions);
      const requestId = message.id;
      const execution = executions.getStore();
      let op = execution?.operation;
      if (message.method === "tools/call" && record(message.params) && typeof message.params.name === "string" &&
          uiUri(state.descriptors.get(message.params.name)) && !op) throw new Error("App wire target has no exact operation mapping");
      if (execution && (message.method === "tools/call" || message.method === "resources/read")) {
        execution.signal?.throwIfAborted();
        // An App descriptor may only be used from its exact actual publication and transport.
        if (!op && uiUri(execution.publication.descriptor)) throw new Error("Missing native App operation");
      }
      if (op && (message.method === "tools/call" || message.method === "resources/read" || (op.kind === "list" && message.method === "resources/list"))) {
        assertOperation(op, sendOptions);
        const params = op.kind === "list" && message.params === undefined ? {} : message.params;
        if (!record(params) || state !== op.binding.transport || state.server !== op.binding.transport.server ||
            (op.kind === "call" ? message.method !== "tools/call" || params.name !== op.publication.rawName :
              op.kind === "read" ? message.method !== "resources/read" || params.uri !== op.uri : message.method !== "resources/list")) throw new Error("Native App before-send target mismatch");
        if (op.kind === "call") {
          if (op.publication.transport !== state || state.descriptors.get(op.publication.rawName ?? "") !== op.publication.descriptor) {
            throw new Error("Native App descriptor/publication mismatch");
          }
          const targetUri = uiUri(op.publication.descriptor);
          if (targetUri && targetUri !== op.binding.uri) throw new Error("Native App before-send UI URI mismatch");
          const args = params.arguments === undefined ? {} : params.arguments;
          if (!record(args)) throw new Error("Invalid native App arguments");
          if (params._meta !== undefined && !record(params._meta)) throw new Error("Invalid native request metadata");
          const prepared = await prepare(op, args, sendOptions);
          assertOperation(op, sendOptions);
          const mode = extractToolUiStreamMode(op.binding.publication.descriptor?._meta);
          if (mode && prepared.kind === "ready") {
            if (params._meta !== undefined && !record(params._meta)) throw new Error("Invalid native request metadata");
            // The only permitted wire change. Arguments and sendOptions retain their original identity.
            message = { ...message, params: { ...params, _meta: { ...params._meta, [UI_STREAM_REQUEST_META_KEY]: op.streamToken } } };
          }
        }
        assertOperation(op, sendOptions);
      } else { op = undefined; } // startup/list requests inheriting ALS are never tool operations.
      const params = record(message.params) ? message.params : undefined;
      const abort = () => {
        state.pending.delete(requestId);
        if (op && !op.answered && op.lease) revokeStream(op.lease);
      };
      const detach = () => sendOptions?.signal?.removeEventListener("abort", abort);
      state.pending.set(requestId, { method: message.method, operation: op, listCursor: params?.cursor, detach });
      sendOptions?.signal?.addEventListener("abort", abort, { once: true });
      try {
        if (op) {
          assertOperation(op, sendOptions);
          if (op.sent) throw new Error("Native App operation cannot replay");
          if (op.origin === "model" && op.lease) {
            op.lease.admission = ++op.binding.admissionSequence;
            reconcileInitial(op.binding, true);
          }
          assertOperation(op, sendOptions);
          // No UI callback/notification occurs after this bit and before the actual delegate.
          op.sent = true;
        }
      } catch (error) { if (op?.lease) revokeStream(op.lease); detach(); state.pending.delete(requestId); throw error; }
      try { await original.send(message, sendOptions); }
      catch (error) { if (op) { op.failure = { kind: "wire-send", error }; if (op.lease) revokeStream(op.lease); } detach(); state.pending.delete(requestId); throw error; }
      // The native send signal is normally aborted after response; only host/publication stay required here.
      if (op) assertOperation(op, op.answered ? undefined : sendOptions);
    };
    // Preserve every descriptor/prototype; methods keep the original receiver.
    const facade: McpTransport = Object.create(Object.getPrototypeOf(original), Object.getOwnPropertyDescriptors(original));
    Object.defineProperties(facade, {
      start: { value: () => original.start(), configurable: true },
      send: { value: send, configurable: true },
      close: { value: () => { retireTransport(state); return original.close(); }, configurable: true },
      onMessage: { value: original.onMessage.bind(original), configurable: true },
      onError: { value: original.onError.bind(original), configurable: true },
      onClose: { value: original.onClose.bind(original), configurable: true },
      ...(original.setProtocolVersion ? { setProtocolVersion: { value: original.setProtocolVersion.bind(original), configurable: true } } : {}),
    });
    return facade;
  }
  function publish<TParams extends TSchema, TDetails, TState>(pi: ExtensionAPI, definition: ToolDefinition<TParams, TDetails, TState>): void {
    if (definition.name === "mcp") throw new Error("Native SDK already defines model tool mcp; UI capability collision requires review");
    const previous = publications.get(definition.name);
    if (previous) revokePublication(previous); // native hidden/replacement fences before original registration.
    const server = definition.namespace?.aliases?.[0];
    const prefix = server === undefined ? undefined : `${server}/`;
    const rawName = prefix && definition.label.startsWith(prefix) ? definition.label.slice(prefix.length) : undefined;
    const matches = rawName === undefined ? [] : [...transports].filter(t => t.live && t.server === server && t.descriptors.has(rawName));
    const transport = matches.length === 1 ? matches[0] : undefined;
    const publication: Publication = { definition, server, rawName, transport,
      descriptor: rawName === undefined ? undefined : transport?.descriptors.get(rawName), live: definition.exposure !== "hidden" };
    publications.set(definition.name, publication);
    const execute: typeof definition.execute = function (...args) {
      const inherited = dispatches.getStore();
      let op = inherited;
      let owned = false;
      if (inherited) {
        assertOperation(inherited);
        if (inherited.publication !== publication) throw new Error("Native publication changed before actual execute");
      } else if (uiUri(publication.descriptor)) {
        const parent = options.host.begin(args[2]);
        let binding: Binding | undefined;
        try {
          binding = createBinding(publication, parent);
          op = createOperation(binding, publication, "call", args[2], undefined, "model");
          owned = true;
        } catch (error) { if (binding && binding.operations.size === 0 && !binding.handle) retire(binding); throw error; }
        finally { parent.finish(); }
      }
      const execution: Execution = { publication, toolCallId: args[0], signal: args[2], context: args[4], operation: op };
      let result: ReturnType<typeof definition.execute>;
      try { result = executions.run(execution, () => definition.execute.apply(definition, args)); }
      catch (error) { if (owned && op) { if (op.lease) revokeStream(op.lease); finish(op); } throw error; }
      // Observe settlement without changing the native Promise, result, receiver or thrown error.
      void result.then(() => {
        if (owned && op) {
          try {
            assertOperation(op);
            const raw = CallToolResultSchema.parse(op.raw);
            if (op.binding.uiState === "ready") op.binding.handle?.sendToolResult(withStreamEnvelope(raw, op.streamId, op.lease ? ++op.lease.sequence : 0));
          } catch (error) { report(error); }
          finally { finish(op); }
        }
      }, error => {
        if (owned && op) {
          try { assertBinding(op.binding); op.binding.handle?.sendToolCancelled(op.sent ? "UNKNOWN: request was sent; no replay" : String(error)); }
          catch (uiError) { report(uiError); }
          finally {
            if (op.lease) revokeStream(op.lease);
            finish(op);
          }
        }
      }).catch(report);
      return result;
    };
    const descriptors = Object.getOwnPropertyDescriptors(definition);
    descriptors.execute = { ...descriptors.execute, value: execute };
    const wrapped: typeof definition = Object.create(Object.getPrototypeOf(definition), descriptors);
    try { pi.registerTool(wrapped); } catch (error) { revokePublication(publication); throw error; }
  }
  const native = createMcpExtension({ ...options.mcp, createTransport: (entry, cwd, authProvider) =>
    wrapTransport(options.createTransport(entry, cwd, authProvider), entry.name) });
  const factory: ExtensionFactory = pi => {
    factoryApi = pi;
    const registerTool: ExtensionAPI["registerTool"] = definition => publish(pi, definition);
    // Proxy only this trusted factory's API. All other methods retain the real API receiver.
    const methods = new Map<PropertyKey, unknown>();
    const facade = new Proxy(pi, {
      get(target, key) {
        if (key === "registerTool") return registerTool;
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!methods.has(key)) methods.set(key, value.bind(target));
        return methods.get(key);
      },
    });
    const result = native(facade);
    // SDK 1.4 registers the /mcp command, not a model tool named mcp. This is
    // intentionally only the original UI-history action, using ordinary conflict rules.
    pi.registerTool({
      name: "mcp", label: "MCP UI messages",
      description: 'Read and clear completed MCP App UI session messages with action "ui-messages". Other MCP operations use the native MCP tools and /mcp command.',
      parameters: Type.Object({ action: Type.Literal("ui-messages") }, { additionalProperties: false }),
      async execute(_toolCallId, params, signal) {
        if (params.action !== "ui-messages") throw new Error("Unsupported MCP UI action");
        const host = options.host.begin(signal);
        try {
          host.assertCurrent();
          // Synchronous formatter/drain: no await or side-effecting transport in between.
          return executeUiMessages(history);
        } finally { host.finish(); }
      },
    });
    return result;
  };
  return { factory, close() { for (const binding of bindings) retire(binding); },
    getCompletedUiSessions: () => history.completedUiSessions.slice() };
}
