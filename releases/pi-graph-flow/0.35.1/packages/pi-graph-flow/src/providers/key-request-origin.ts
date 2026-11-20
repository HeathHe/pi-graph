import { resolve as resolvePath } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { types as utilTypes } from "node:util";
/** Request identity only. Credentials remain in the original SDK / models Host. */
import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import { observeModelApiKeyAuth, observeModelRequestPreparation, type ModelApiKeyObservation, type StandardHttpPreparation } from "pi-graph-host-compat/model-runtime";
import { readAdmittedModelOperation, subscribeAdmittedModelOperationTerminal, type AdmittedModelOperation } from "../sdk-host/model-request-gate.ts";
export interface ManagedKeySettlement { recorded: boolean; advancedTo?: string; }
export interface ManagedKeyOrigin {
  readonly providerId: string;
  readonly modelsPath: string;
  readonly keyId: string;
  readonly incarnation: string;
  settle(status: number, isCurrentRegistration: () => boolean): Promise<ManagedKeySettlement | undefined>;
}
interface BoundKeyOrigin extends Omit<ManagedKeyOrigin, "settle"> {
  isCurrentRegistration(): boolean;
  settle(status: number): Promise<ManagedKeySettlement | undefined>;
}
export interface ManagedRegistrationSource {
  readonly providerId: string;
  matches(registration: object, result: unknown): boolean;
  bind(): Promise<ManagedKeyOrigin | undefined>;
}
export const KEY_ORIGIN_FIELD = "__piGraphManagedKeyOrigin_v1";
interface HttpSettlement { active: boolean; origin?: BoundKeyOrigin; readonly status: number; promise?: Promise<ManagedKeySettlement | undefined>; }
interface Frame { readonly ctx: object; readonly providerId: string; runtime?: object; manager?: object; headersHook?: Function; httpMetadata?: AdmittedModelOperation; httpSettlement?: HttpSettlement; authKey?: string; captureHttpAuth?: boolean; frozen: boolean; authCount: number; invalidHeaders?: boolean; origin?: BoundKeyOrigin; }
interface OriginState {
  issued: WeakMap<object, ManagedRegistrationSource>;
  effective: WeakMap<object, ManagedRegistrationSource | false>;
  frames: AsyncLocalStorage<Frame>;
  http?: HttpObserverState;
}
const identity = Symbol.for(`pi-graph:key-request-origin:v1:${realpathSync(fileURLToPath(import.meta.url))}`);
const globalState = globalThis as typeof globalThis & { [identity]?: OriginState };
const state = globalState[identity] ??= { issued: new WeakMap(), effective: new WeakMap(), frames: new AsyncLocalStorage() };
function object(v: unknown): v is object { return typeof v === "object" && v !== null; }
function issued(registration: unknown): ManagedRegistrationSource | undefined {
  if (!object(registration)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(registration, KEY_ORIGIN_FIELD);
  return descriptor && !descriptor.get && !descriptor.set && object(descriptor.value) ? state.issued.get(descriptor.value) : undefined;
}
export function issueManagedKeyRegistration<T extends object>(registration: T, source: ManagedRegistrationSource): T {
  if (Object.hasOwn(registration, KEY_ORIGIN_FIELD)) return registration;
  const token = Object.freeze({}); state.issued.set(token, source);
  Object.defineProperty(registration, KEY_ORIGIN_FIELD, { value: token, enumerable: true, configurable: false, writable: false });
  return registration;
}
export function currentManagedKeyOrigin(providerId: string, ctx: object, modelsPath: string): BoundKeyOrigin | undefined {
  const frame = state.frames.getStore();
  return frame?.ctx === ctx && frame.providerId === providerId && frame.frozen && frame.origin?.modelsPath === resolvePath(modelsPath) ? frame.origin : undefined;
}
/** Includes lazy stream.result(); the source is frozen after genuine SDK auth. */
export async function withManagedKeyRequest<T>(version: string, ctx: object & { modelRegistry: unknown; sessionManager: unknown }, providerId: string,
  run: (hooks: { transformHeaders<H extends Record<string, string | null>>(headers: H): H; bindResponse<F extends (...args: any[]) => unknown>(callback: F): F }) => Promise<T>): Promise<T> {
  const frame: Frame = { ctx, providerId, frozen: false, authCount: 0 };
  try {
    if (object(ctx.modelRegistry)) {
      const runtime: unknown = Reflect.get(ctx.modelRegistry, "runtime");
      if (object(runtime) && object(ctx.sessionManager)) { frame.runtime = runtime; frame.manager = ctx.sessionManager; }
    }
  } catch { /* unavailable identity remains unknown without changing the operation */ }
  let dispose: (() => void) | undefined;
  const begin = (observation: ModelApiKeyObservation) => {
    if (state.frames.getStore() !== frame || frame.frozen || observation.providerId !== providerId) return;
    frame.authCount++;
    if (frame.authCount !== 1) { frame.origin = undefined; return; }
    const input = observation.input;
    // Stored and explicit credentials keep the SDK's precedence, never the managed active key.
    if (!object(input) || Reflect.get(input, "credential") !== undefined || !observation.registration) return;
    const overrides = observation.overrides;
    if ((object(overrides) && (Reflect.get(overrides, "apiKey") !== undefined || Reflect.get(overrides, "env") !== undefined))
      || (object(observation.model) && Reflect.get(observation.model, "headers") !== undefined)) return;
    const cached = state.effective.get(observation.registration);
    const source = cached === false ? undefined : cached ?? issued(observation.registration);
    if (!source || source.providerId !== providerId) return;
    return async (result: unknown) => {
      if (frame.invalidHeaders || frame.frozen || frame.authCount !== 1 || !source.matches(observation.registration!, result)) return;
      const origin = await source.bind();
      if (origin && !frame.invalidHeaders && frame.authCount === 1 && !frame.frozen) {
        const boundOrigin: BoundKeyOrigin = {
        providerId: origin.providerId, modelsPath: origin.modelsPath, keyId: origin.keyId, incarnation: origin.incarnation,
        isCurrentRegistration: observation.isCurrentRegistration,
        settle(status) {
          const fact = state.frames.getStore()?.httpSettlement;
          if (!fact?.active || fact.origin !== boundOrigin || fact.status !== status) return Promise.resolve(undefined);
          // Auth identity is not a failure fact. Only this existing operation's
          // original serialized HTTP observation can delegate the original writer.
          return fact.promise ??= origin.settle(status, observation.isCurrentRegistration);
        },
        };
        frame.origin = boundOrigin;
        if (frame.captureHttpAuth) {
          try {
            const auth = object(result) ? Reflect.get(result, "auth") : undefined;
            const key: unknown = object(auth) ? Reflect.get(auth, "apiKey") : undefined;
            if (typeof key === "string") frame.authKey = key;
          } catch { /* Snapshot unavailable; preserve the original known origin and SDK result. */ }
        }
      }
    };
  };
  try {
    try { dispose = observeModelApiKeyAuth(version, ctx, { begin, registered(incoming, effective) {
      if (effective) state.effective.set(effective, issued(incoming) ?? false);
    } }); } catch { /* unsupported observation is an unknown attribution, not an auth fallback */ }
    const transformHeaders = <H extends Record<string, string | null>>(headers: H): H => { frame.frozen = true; return headers; };
    frame.headersHook = transformHeaders;
    return await state.frames.run(frame, () => run({
      transformHeaders,
      bindResponse(callback) {
        return function(this: unknown, ...args: any[]) { return state.frames.run(frame, () => Reflect.apply(callback, this, args)); } as typeof callback;
      },
    }));
  } finally { dispose?.(); }
}

function headerSnapshot(value: unknown): Map<string, string | null> | undefined {
  if (!object(value) || utilTypes.isProxy(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return undefined;
  const result = new Map<string, string | null>();
  for (const name of Reflect.ownKeys(value)) {
    if (typeof name !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.get || descriptor.set || (typeof descriptor.value !== "string" && descriptor.value !== null)) return undefined;
    result.set(name, descriptor.value);
  }
  return result;
}
function sameHeaders(before: Map<string, string | null> | undefined, value: unknown): boolean {
  try {
    const after = headerSnapshot(value);
    return before !== undefined && after !== undefined && before.size === after.size && [...before].every(([name, v]) => after.get(name) === v && after.has(name));
  } catch { return false; }
}
function checkedHeaders(frame: Frame, original: unknown): (headers: Record<string, string | null>) => Promise<unknown> {
  return function(this: unknown, ...args: [Record<string, string | null>]) {
    let before: Map<string, string | null> | undefined;
    try { before = headerSnapshot(args[0]); } catch { /* an opaque record is not proof of unchanged credentials */ }
    const operation = typeof original === "function" ? Reflect.apply(original, this, args) : args[0];
    return Promise.resolve(operation).then(result => {
      if (!sameHeaders(before, result)) { frame.origin = undefined; frame.invalidHeaders = true; }
      frame.frozen = true;
      return result;
    });
  };
}
function plainRecord(value: unknown): value is Record<string, unknown> {
  return object(value) && !utilTypes.isProxy(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(d => !d.get && !d.set);
}
interface HttpOperationFact {
  closed: boolean; ambiguous: boolean; fetchCount: number; requests: HttpRequestFact[];
  keyOrigin?: BoundKeyOrigin;
  readonly frame: Frame; readonly origin: string; readonly host: string; readonly path: string;
}
interface HttpRequestFact { readonly request: object; readonly operation: HttpOperationFact; sends: number; finals: number; matched: boolean; complete: boolean; status?: number; }
interface HttpObserverState {
  invocations: AsyncLocalStorage<HttpOperationFact>;
  requests: WeakMap<object, HttpRequestFact>;
  users: number;
  start(): void;
  stop(): void;
}
/** Native event data only; reading a callback/accessor is not evidence. */
function eventData(value: unknown, key: string): unknown {
  if (!object(value) || utilTypes.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}
function serializedRequestMatches(request: object, value: unknown, operation: HttpOperationFact): boolean {
  try {
    if (!operation.frame.authKey || typeof value !== "string" || value.length > 65_536) return false;
    const lines = value.split("\r\n"), first = lines.shift();
    if (first !== `POST ${operation.path} HTTP/1.1` || lines.pop() !== "") return false;
    const headers = new Map<string, string>();
    for (const line of lines) {
      const pair = /^([!#$%&'*+\-.^_`|~0-9A-Za-z]+):[ \t]*(.*)$/.exec(line);
      if (!pair || headers.has(pair[1].toLowerCase())) return false;
      headers.set(pair[1].toLowerCase(), pair[2]);
    }
    const origin = eventData(request, "origin"), path = eventData(request, "path"), method = eventData(request, "method");
    return typeof origin === "string" && new URL(origin).origin === operation.origin
      && method === "POST" && path === operation.path && headers.get("host")?.toLowerCase() === operation.host.toLowerCase()
      && headers.get("authorization") === `Bearer ${operation.frame.authKey}`
      && !["cookie", "proxy-authorization", "x-api-key", "api-key", "x-goog-api-key", "x-amz-security-token"].some(name => headers.has(name));
  } catch { return false; }
}
function httpObservers(): HttpObserverState {
  if (state.http) return state.http;
  const invocations = new AsyncLocalStorage<HttpOperationFact>(), requests = new WeakMap<object, HttpRequestFact>();
  const created = channel("undici:request:create"), sent = channel("undici:client:sendHeaders"), received = channel("undici:request:headers");
  const onCreate = (event: unknown) => {
    try {
      const operation = invocations.getStore(), request = eventData(event, "request");
      if (!operation || operation.closed || !object(request) || utilTypes.isProxy(request)) return;
      if (requests.has(request) || operation.requests.length >= 2) { operation.ambiguous = true; return; }
      const fact: HttpRequestFact = { request, operation, sends: 0, finals: 0, matched: false, complete: false };
      operation.requests.push(fact); requests.set(request, fact);
    } catch { const operation = invocations.getStore(); if (operation && !operation.closed) operation.ambiguous = true; }
  };
  const onSend = (event: unknown) => {
    try {
      const request = eventData(event, "request"), fact = object(request) ? requests.get(request) : undefined;
      if (!fact || fact.operation.closed) return;
      fact.sends++;
      fact.matched = fact.sends === 1 && serializedRequestMatches(fact.request, eventData(event, "headers"), fact.operation);
    } catch { /* Unknown source is never an auth or producer fallback. */ }
  };
  const onHeaders = (event: unknown) => {
    try {
      const request = eventData(event, "request"), fact = object(request) ? requests.get(request) : undefined;
      if (!fact || fact.operation.closed) return;
      const status = eventData(eventData(event, "response"), "statusCode");
      if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) { fact.operation.ambiguous = true; return; }
      if (status < 200) return;
      fact.finals++; fact.complete = true;
      fact.status = fact.finals === 1 && fact.sends === 1 && fact.matched && ([401, 403, 429].includes(status) || status >= 500) ? status : undefined;
    } catch { /* Observation cannot change the original parser/handler result. */ }
  };
  const observer: HttpObserverState = { invocations, requests, users: 0,
    start() {
      if (observer.users++ !== 0) return;
      try { created.subscribe(onCreate); sent.subscribe(onSend); received.subscribe(onHeaders); }
      catch (error) { observer.users = 0; created.unsubscribe(onCreate); sent.unsubscribe(onSend); received.unsubscribe(onHeaders); throw error; }
    },
    stop() {
      if (observer.users <= 0 || --observer.users !== 0) return;
      created.unsubscribe(onCreate); sent.unsubscribe(onSend); received.unsubscribe(onHeaders);
    },
  };
  state.http = observer; return observer;
}
function releaseHttpAuthSnapshot(frame: Frame): void { frame.authKey = undefined; frame.captureHttpAuth = false; }
/** Pin the installed observer's original facade, never look up a later owner. */
async function settleHttpFact(origin: BoundKeyOrigin, frame: Frame, observerCtx: object, status: number,
  providerId: string, onFailure: (providerId: string, status: number) => Promise<void>): Promise<void> {
  const fact: HttpSettlement = { active: true, origin, status };
  // Explicit fields avoid even a temporary copied authKey/raw-header reference.
  // This is observation bookkeeping in the existing ALS, not another auth owner.
  const scope: Frame = { ctx: observerCtx, providerId: frame.providerId, runtime: frame.runtime, manager: frame.manager,
    frozen: true, authCount: frame.authCount, origin, httpSettlement: fact };
  try { await state.frames.run(scope, () => onFailure(providerId, status)); }
  finally { fact.active = false; fact.origin = undefined; fact.promise = undefined; scope.origin = undefined; }
}
function observeStandardHttpFact(candidate: StandardHttpPreparation, metadata: AdmittedModelOperation, frame: Frame, observerCtx: object,
  providerId: string, onFailure: (providerId: string, status: number) => Promise<void>): boolean {
  const options = candidate.options;
  if (!plainRecord(options) || !frame.origin) return false;
  const originalFetch = options.fetch;
  if (originalFetch !== undefined && typeof originalFetch !== "function") return false;
  const expected = new URL(candidate.baseUrl.replace(/\/$/, "") + (candidate.api === "openai-responses" ? "/responses" : "/chat/completions"));
  if (!["http:", "https:"].includes(expected.protocol) || expected.username || expected.password || expected.search || expected.hash) return false;
  const operation: HttpOperationFact = { closed: false, ambiguous: false, fetchCount: 0, requests: [], frame, keyOrigin: frame.origin, origin: expected.origin, host: expected.host, path: expected.pathname };
  const observers = httpObservers(); let started = false;
  const cleanup = () => {
    operation.closed = true;
    for (const fact of operation.requests) observers.requests.delete(fact.request);
    operation.requests.length = 0;
    if (started) { started = false; observers.stop(); }
    operation.keyOrigin = undefined;
    if (frame.httpMetadata === metadata) frame.httpMetadata = undefined;
    releaseHttpAuthSnapshot(frame); frame.origin = undefined;
  };
  const dispose = subscribeAdmittedModelOperationTerminal(metadata, async () => {
    operation.closed = true;
    const [fact] = operation.requests;
    const status = !operation.ambiguous && operation.fetchCount === 1 && operation.requests.length === 1
      && fact.complete && fact.sends === 1 && fact.finals === 1 ? fact.status : undefined;
    // Original qualification was valid at prepare/subscribe. Closing or a new
    // observer must not erase this known old fact or move it to a new handler.
    const origin = operation.keyOrigin;
    try { if (status !== undefined && origin) await settleHttpFact(origin, frame, observerCtx, status, providerId, onFailure); }
    finally { cleanup(); }
  });
  if (!dispose) return false;
  const wrappers = new WeakMap<Function, Function>();
  const wrap = (delegate: Function) => {
    const prior = wrappers.get(delegate); if (prior) return prior;
    const wrapper = function(this: unknown, ...args: unknown[]) {
      if (operation.closed) return Reflect.apply(delegate, this, args);
      operation.fetchCount++;
      // ALS only introduces the actual native request; every later event uses
      // the exact request WeakMap identity, including pooled-response contexts.
      return observers.invocations.run(operation, () => Reflect.apply(delegate, this, args));
    };
    wrappers.set(delegate, wrapper); return wrapper;
  };
  try {
    observers.start(); started = true;
    if (typeof originalFetch === "function") options.fetch = wrap(originalFetch);
    else Object.defineProperty(options, "fetch", { enumerable: true, configurable: true, get() {
      const delegate = globalThis.fetch; return typeof delegate === "function" ? wrap(delegate) : undefined;
    } });
  } catch { dispose(); cleanup(); return false; }
  return true;
}
/** Ordinary native HTTP only; no stream decoration, event synthesis, or credential owner. */
export function observeManagedKeyPreparations(version: string, ctx: object & { modelRegistry: unknown; sessionManager: unknown },
  onFailure: (providerId: string, status: number) => Promise<void>): () => void {
  const consumed = new WeakSet<object>();
  return observeModelRequestPreparation(version, ctx, { run(input, prepare) {
    const inherited = state.frames.getStore();
    const revokeInherited = () => { if (inherited) { inherited.invalidHeaders = true; inherited.origin = undefined; } };
    const options = input.options;
    if (!object(options)) return prepare(options);
    // Accessors/proxies cannot silently become a trusted options/source record.
    try {
      if (utilTypes.isProxy(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
        || Object.values(Object.getOwnPropertyDescriptors(options)).some(d => d.get || d.set)) { revokeInherited(); return prepare(options); }
    } catch { revokeInherited(); return prepare(options); }
    const transform = Reflect.get(options, "transformHeaders");
    // The original SDK invokes a truthy transform, so invalid input must retain
    // its original TypeError rather than becoming an identity transform.
    if (transform && typeof transform !== "function") { revokeInherited(); return prepare(options); }
    let emptyInitialHeaders = false;
    try {
      const headers: unknown = Reflect.get(options, "headers");
      emptyInitialHeaders = headers === undefined || (object(headers) && !utilTypes.isProxy(headers)
        && [Object.prototype, null].includes(Object.getPrototypeOf(headers)) && Reflect.ownKeys(headers).length === 0);
    } catch { /* opaque initial headers cannot establish the actual credential */ }
    if (!emptyInitialHeaders) {
      revokeInherited();
      return prepare(options);
    }
    const providerDescriptor = object(input.model) ? Object.getOwnPropertyDescriptor(input.model, "provider") : undefined;
    const providerId: unknown = providerDescriptor && !providerDescriptor.get && !providerDescriptor.set ? providerDescriptor.value : undefined;
    if (typeof providerId !== "string") return prepare(options);
    const metadata = readAdmittedModelOperation(input.runtime, input.manager, input.model, options);
    const admitted = metadata && metadata.operation === "stream" && !consumed.has(metadata)
      && [undefined, 0].includes(Reflect.get(options, "maxRetries"))
      && [undefined, "sse"].includes(Reflect.get(options, "transport")) && input.mayObserveStandardHttpAuth ? metadata : undefined;
    const prepareInFrame = (frame: Frame) => {
      // One original auth/frame and one claimed operation, including Vision.
      // A reused already-authenticated frame cannot lend its origin to another send.
      const claimed = admitted && frame.runtime === input.runtime && frame.manager === input.manager
        && !frame.httpMetadata && !frame.frozen && frame.authCount === 0 ? admitted : undefined;
      if (claimed) { consumed.add(claimed); frame.httpMetadata = claimed; frame.captureHttpAuth = true; }
      let retained = false, operation: unknown;
      const release = () => {
        if (claimed && !retained) {
          if (frame.httpMetadata === claimed) frame.httpMetadata = undefined;
          releaseHttpAuthSnapshot(frame);
        }
      };
      try { operation = prepare({ ...options, transformHeaders: checkedHeaders(frame, Reflect.get(options, "transformHeaders")) }); }
      catch (error) { release(); throw error; }
      return Promise.resolve(operation).then(prepared => {
        try {
          if (!claimed) return prepared;
          claimed.assertCurrent();
          if (!frame.origin || !frame.authKey || !frame.frozen || !object(prepared)) return prepared;
          const candidate = input.captureStandardHttpPreparation(prepared);
          if (candidate) retained = observeStandardHttpFact(candidate, claimed, frame, ctx, providerId, onFailure);
        } catch { /* Unknown metadata cannot replace original prepare/producer behavior. */ }
        return prepared;
      }).finally(release);
    };
    if (inherited) {
      // This is only the already-issued same native tuple/headers hook. The ctx
      // facade may differ; never accept a caller-supplied replacement observer.
      if (inherited.runtime !== input.runtime || inherited.manager !== input.manager || inherited.providerId !== providerId
        || typeof inherited.headersHook !== "function" || Reflect.get(options, "transformHeaders") !== inherited.headersHook) return prepare(options);
      return prepareInFrame(inherited);
    }
    if (!admitted) return prepare(options);
    return withManagedKeyRequest(version, ctx, providerId, () => prepareInFrame(state.frames.getStore()!));
  } });
}
