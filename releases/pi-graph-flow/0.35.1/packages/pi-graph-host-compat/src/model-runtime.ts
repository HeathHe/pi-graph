import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** Fixed 1.4 compatibility bridge. This intentionally uses a versioned private field. */
export type RuntimeMethod = (...args: unknown[]) => unknown;
export interface ModelRuntimeBridge {
  readonly runtime: object;
  readonly manager: object;
  assertCurrent(): void;
  original(target: object, name: string): RuntimeMethod;
  replace(target: object, name: string, replacement: RuntimeMethod): () => void;
}
interface Decoration { target: object; name: string; original: RuntimeMethod; baseline?: PropertyDescriptor; }
// Ownership metadata only: duplicate plugin module graphs must recognize their
// own decorators. It stores no model selection, request authority, or balance.
const key = Symbol.for("pi-graph:model-runtime-decoration:v1");
const globalRegistry = globalThis as typeof globalThis & { [key]?: WeakMap<RuntimeMethod, Decoration> };
const decorations = globalRegistry[key] ??= new WeakMap<RuntimeMethod, Decoration>();
function object(value: unknown): value is object { return typeof value === "object" && value !== null; }
export function readModelRuntimeBridge(version: string, ctx: {
  readonly modelRegistry: unknown; readonly sessionManager: unknown;
}): ModelRuntimeBridge {
  if (!/^1\.4\.0(?:[+_-].*)?$/.test(version)) throw new Error(`Goal budget runtime capability unsupported on Pi ${version}`);
  // Reading these original getters also invokes the SDK's current-context fence.
  const registry = ctx.modelRegistry, manager = ctx.sessionManager;
  if (!object(registry) || !object(manager)) throw new Error("Goal budget SDK context capability unavailable");
  const descriptor = Object.getOwnPropertyDescriptor(registry, "runtime");
  const runtime: unknown = Reflect.get(registry, "runtime");
  if (!descriptor || descriptor.get || !object(runtime) || descriptor.value !== runtime) throw new Error("Unrecognized Pi 1.4 ModelRegistry runtime shape");
  for (const name of ["stream", "streamSimple"]) {
    if (typeof Reflect.get(runtime, name) !== "function") throw new Error(`Pi runtime missing ${name}`);
  }
  for (const name of ["appendMessage", "appendUsage", "getEntry", "getSessionFile", "getSessionId"]) {
    if (typeof Reflect.get(manager, name) !== "function") throw new Error(`Pi session journal missing ${name}`);
  }
  const assertCurrent = () => {
    if (ctx.modelRegistry !== registry || ctx.sessionManager !== manager || Reflect.get(registry, "runtime") !== runtime) {
      throw new Error("Goal budget SDK session changed");
    }
  };
  const original = (target: object, name: string): RuntimeMethod => {
    const before = Object.getOwnPropertyDescriptor(target, name);
    const method = Reflect.get(target, name);
    const owned = typeof method === "function" ? decorations.get(method as RuntimeMethod) : undefined;
    if (before && (!owned || owned.target !== target || owned.name !== name || before.value !== method
      || before.get || before.set || !before.configurable || !before.writable)) {
      throw new Error(`Pi ${name} already has an unowned decoration`);
    }
    if (typeof method !== "function") throw new Error(`Pi ${name} is not callable`);
    return owned?.original ?? method as RuntimeMethod;
  };
  return { runtime, manager, assertCurrent, original,
    replace(target, name, replacement) {
      assertCurrent();
      const sdkMethod = original(target, name);
      const before = Object.getOwnPropertyDescriptor(target, name);
      const previous = before && decorations.get(before.value as RuntimeMethod);
      const baseline = previous?.baseline ?? (previous ? undefined : before);
      decorations.set(replacement, { target, name, original: sdkMethod, baseline });
      Object.defineProperty(target, name, { value: replacement, configurable: true, writable: true, enumerable: false });
      return () => {
        // A retired generation never restores over a later owned or foreign wrapper.
        if (Object.getOwnPropertyDescriptor(target, name)?.value !== replacement) return;
        if (baseline) Object.defineProperty(target, name, baseline); else Reflect.deleteProperty(target, name);
      };
    },
  };
}


/** A fixed-SDK observation, never a replacement credential or dispatch permit. */
export interface ModelApiKeyObservation {
  readonly providerId: string;
  readonly registration: object | undefined;
  readonly provider: object;
  readonly input: unknown;
  readonly model: unknown;
  readonly overrides: unknown;
  isCurrentRegistration(): boolean;
}
export interface ModelApiKeyObserver {
  begin(observation: ModelApiKeyObservation): ((result: unknown) => void | Promise<void>) | undefined;
  registered?(incoming: unknown, effective: object | undefined): void;
}
interface AuthDecoration { target: object; original: RuntimeMethod; wrapper: RuntimeMethod; before: PropertyDescriptor; registration: object | undefined; }
interface AuthObservers { observers: Set<ModelApiKeyObserver>; checks: Map<ModelApiKeyObserver, () => void>; dispose(): void; }
const authKey = Symbol.for(`pi-graph:auth-observers:v1:${realpathSync(fileURLToPath(import.meta.url))}`);
interface AuthDecorationState { observers: WeakMap<object, AuthObservers>; uncertain: WeakMap<object, Set<string>>; }
const authGlobal = globalThis as typeof globalThis & { [authKey]?: AuthDecorationState };
const authState = authGlobal[authKey] ??= { observers: new WeakMap<object, AuthObservers>(), uncertain: new WeakMap<object, Set<string>>() };
const authObservers = authState.observers;
/** Observe the SDK's own composed resolver. getAuth and resolve delegate before any await. */
export function observeModelApiKeyAuth(version: string, ctx: Parameters<typeof readModelRuntimeBridge>[1], observer: ModelApiKeyObserver): () => void {
  const bridge = readModelRuntimeBridge(version, ctx);
  const current = authObservers.get(bridge.runtime);
  if (current) {
    current.observers.add(observer); current.checks.set(observer, bridge.assertCurrent);
    return () => { current.observers.delete(observer); current.checks.delete(observer); if (!current.observers.size && authObservers.get(bridge.runtime) === current) { authObservers.delete(bridge.runtime); current.dispose(); } };
  }
  const models: unknown = Reflect.get(bridge.runtime, "models");
  if (!object(models) || typeof Reflect.get(models, "getProvider") !== "function" || typeof Reflect.get(bridge.runtime, "getRegisteredProviderConfig") !== "function") throw new Error("Pi auth observation capability unavailable");
  // Only failed observation markers, never credentials/key selection. They must
  // survive lease disposal so a failed registration cannot bootstrap as known.
  const uncertain = authState.uncertain.get(bridge.runtime) ?? new Set<string>();
  authState.uncertain.set(bridge.runtime, uncertain);
  const observers = new Set([observer]);
  const checks = new Map([[observer, bridge.assertCurrent]]);
  const wrapped = new Map<object, AuthDecoration>();
  const calls = new AsyncLocalStorage<{ provider: object; registration: object | undefined; model: unknown; overrides: unknown }>();
  const originalGetAuth = bridge.original(models, "getAuth");
  const originalRegister = bridge.original(bridge.runtime, "registerProvider");
  const notify = (run: (observer: ModelApiKeyObserver) => void) => { for (const o of observers) { try { checks.get(o)?.(); run(o); } catch { /* attribution must not replace SDK auth */ } } };
  const instrument = (provider: object, providerId: string, registration: object | undefined) => {
    const auth: unknown = Reflect.get(provider, "auth");
    const method: unknown = object(auth) ? Reflect.get(auth, "apiKey") : undefined;
    if (!object(method)) return;
    const prior = wrapped.get(method);
    if (prior) return;
    const before = Object.getOwnPropertyDescriptor(method, "resolve");
    // The fixed composer creates an ordinary own async resolve data property.
    // No generic own-method exception is added to the stream bridge above.
    if (!before || before.get || before.set || !before.configurable || !before.writable || typeof before.value !== "function") return;
    const original = before.value as RuntimeMethod;
    // Fixed 1.4 composer shape only, not a defence against arbitrary malicious
    // code in this process. Bundled/minified or foreign resolvers stay unknown.
    const body = Function.prototype.toString.call(original);
    if (createHash("sha256").update(body).digest("hex") !== "c0aac26275cc02ecdd4892d3c2681e6c67787845239870480fb21e1964519bb9") return;
    const wrapper: RuntimeMethod = function(this: unknown, ...args: unknown[]) {
      const completions: Array<(result: unknown) => void | Promise<void>> = [];
      const call = calls.getStore();
      if (call?.provider === provider && Object.getOwnPropertyDescriptor(method, "resolve")?.value === wrapper) notify(o => {
        const check = checks.get(o);
        const completion = o.begin({ providerId, registration: call.registration, provider, input: args[0], model: call.model, overrides: call.overrides,
          isCurrentRegistration() {
            try {
              if (!check || !call.registration) return false;
              check();
              return Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]) === call.registration;
            } catch { return false; }
          },
        });
        if (completion) completions.push(completion);
      });
      // Preserve the original receiver/arguments, exactly one original invocation,
      // and the very same resolved auth object / rejected Error object.
      const result = Reflect.apply(original, this, args);
      return Promise.resolve(result).then(async value => {
        for (const completion of completions) { try { await completion(value); } catch { /* unknown source, not another authentication attempt */ } }
        return value;
      });
    };
    wrapped.set(method, { target: method, original, wrapper, before, registration });
    Object.defineProperty(method, "resolve", { ...before, value: wrapper });
  };
  const restoreGetAuth = bridge.replace(models, "getAuth", function(this: unknown, ...args: unknown[]) {
    let call: { provider: object; registration: object | undefined; model: unknown; overrides: unknown } | undefined;
    try {
      let live = false;
      for (const o of observers) { try { checks.get(o)?.(); live = true; break; } catch { /* old context is not the new owner's fence */ } }
      if (!live) throw new Error("Pi auth observation context retired");
      const first = args[0];
      const providerId = typeof first === "string" ? first : object(first) ? Reflect.get(first, "provider") : undefined;
      if (typeof providerId === "string") {
        const provider: unknown = Reflect.apply(Reflect.get(models, "getProvider") as RuntimeMethod, models, [providerId]);
        const registered: unknown = Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]);
        if (object(provider)) {
          const registration = !uncertain.has(providerId) && object(registered) ? registered : undefined;
          instrument(provider, providerId, registration);
          call = { provider, registration, model: first, overrides: args[1] };
        }
      }
    } catch { /* observation unavailable: original SDK must still run */ }
    // No metadata I/O or asynchronous boundary precedes this original lookup.
    return call ? calls.run(call, () => Reflect.apply(originalGetAuth, this, args)) : Reflect.apply(originalGetAuth, this, args);
  });
  let restoreRegister: () => void;
  try {
    restoreRegister = bridge.replace(bridge.runtime, "registerProvider", function(this: unknown, ...args: unknown[]) {
      const result = Reflect.apply(originalRegister, this, args);
      try {
        const effective: unknown = typeof args[0] === "string" ? Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [args[0]]) : undefined;
        if (typeof args[0] === "string") uncertain.delete(args[0]);
        notify(o => o.registered?.(args[1], object(effective) ? effective : undefined));
      } catch {
        if (typeof args[0] === "string") uncertain.add(args[0]);
        // Metadata failure remains unknown across observers, never an SDK error.
      }
      return result;
    });
  } catch (error) { restoreGetAuth(); throw error; }
  const state: AuthObservers = { observers, checks, dispose() {
    restoreRegister(); restoreGetAuth();
    for (const d of wrapped.values()) if (Object.getOwnPropertyDescriptor(d.target, "resolve")?.value === d.wrapper) Object.defineProperty(d.target, "resolve", d.before);
  } };
  authObservers.set(bridge.runtime, state);
  return () => { observers.delete(observer); checks.delete(observer); if (!observers.size && authObservers.get(bridge.runtime) === state) { authObservers.delete(bridge.runtime); state.dispose(); } };
}

export interface OrdinaryHttpPreparation {
  readonly providerId: string;
  readonly api: "openai-responses" | "openai-completions";
  readonly baseUrl: string;
  readonly provider: object;
  readonly registration: object;
  readonly options: object;
}
/** Candidate data only. A standard API is never producer or wire provenance. */
export type StandardHttpPreparation = OrdinaryHttpPreparation;
export interface ModelRequestPreparationInput {
  readonly runtime: object;
  readonly manager: object;
  readonly model: unknown;
  readonly options: unknown;
  /** Fixed SDK builtin OpenAI base branch only; never an api-name assertion. */
  isStockOpenAIHttp(prepared: unknown): boolean;
  /** Ownership candidate only, never proof of the public API registry's closed-over producer. */
  captureOrdinaryHttpPreparation(prepared: unknown): OrdinaryHttpPreparation | undefined;
  /** Preliminary ownership candidate only; asks for a short-lived auth snapshot, never a send/health permit. */
  readonly mayObserveOrdinaryHttpAuth: boolean;
  /** One standard HTTP ownership/endpoint candidate; health requires original serialized request evidence. */
  captureStandardHttpPreparation(prepared: unknown): StandardHttpPreparation | undefined;
  readonly mayObserveStandardHttpAuth: boolean;
}
export interface ModelRequestPreparationObserver {
  run(input: ModelRequestPreparationInput, prepare: (options: unknown) => unknown): unknown;
}
interface PreparationObservers {
  observers: Map<ModelRequestPreparationObserver, ModelRuntimeBridge>;
  wrapper: RuntimeMethod;
  dispose(): void;
}
const preparationKey = Symbol.for(`pi-graph:request-preparation:v1:${realpathSync(fileURLToPath(import.meta.url))}`);
const preparationGlobal = globalThis as typeof globalThis & { [preparationKey]?: WeakMap<object, PreparationObservers> };
const preparations = preparationGlobal[preparationKey] ??= new WeakMap<object, PreparationObservers>();
function bodySHA(value: unknown): string | undefined {
  return typeof value === "function" ? createHash("sha256").update(Function.prototype.toString.call(value)).digest("hex") : undefined;
}
function data(value: object, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && !descriptor.get && !descriptor.set ? descriptor.value : undefined;
}
function mapValue(value: unknown, name: string): unknown {
  return object(value) ? Map.prototype.get.call(value, name) : undefined;
}
function stockOpenAICapture(bridge: ModelRuntimeBridge, model: unknown): (prepared: unknown) => boolean {
  try {
    if (!object(model) || data(model, "provider") !== "openai" || data(model, "api") !== "openai-responses") return () => false;
    const defaults = data(bridge.runtime, "defaultBuiltins"), builtins = data(bridge.runtime, "builtins");
    const native = data(bridge.runtime, "nativeExtensionProviders"), models = data(bridge.runtime, "models");
    const base = mapValue(defaults, "openai");
    if (!object(base) || mapValue(builtins, "openai") !== base || mapValue(native, "openai") !== undefined || !object(models)) return () => false;
    if (bodySHA(data(base, "streamSimple")) !== "c38778722135a771c079545bda99bfc134970490e70b692eee815b6a71230bb1"
      || bodySHA(data(base, "stream")) !== "e69cb89367796e89cbece84e9fca663fe694e32c9d062d0ba369d68b9dbacbf8") return () => false;
    const baseStream = data(base, "stream"), baseSimple = data(base, "streamSimple");
    const currentProvider = () => Reflect.apply(Reflect.get(models, "getProvider") as RuntimeMethod, models, ["openai"]);
    const currentRegistration = () => Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, ["openai"]);
    const provider: unknown = currentProvider(), registration: unknown = currentRegistration();
    if (!object(provider) || !object(registration) || Reflect.get(registration, "streamSimple") !== undefined
      || bodySHA(data(provider, "streamSimple")) !== "7a4214b42554ac7177d1768e64e43ec728a96ade988dec1b5f30e73a184a6e90"
      || bodySHA(data(provider, "stream")) !== "6f9ae64062ae6df4c4730ae9222acc0ec933c8ee5ccf148851e7b4e24e5527db") return () => false;
    const providerStream = data(provider, "stream"), providerSimple = data(provider, "streamSimple");
    const getModels: unknown = data(base, "getModels");
    const supports = typeof getModels === "function" && Reflect.apply(getModels, base, []).some((entry: unknown) => object(entry) && Reflect.get(entry, "api") === "openai-responses");
    if (!supports) return () => false;
    return prepared => {
      try {
        bridge.assertCurrent();
        return object(prepared) && Reflect.get(prepared, "provider") === provider && currentRegistration() === registration
          && data(bridge.runtime, "defaultBuiltins") === defaults && data(bridge.runtime, "builtins") === builtins
          && data(bridge.runtime, "nativeExtensionProviders") === native && mapValue(defaults, "openai") === base && mapValue(builtins, "openai") === base
          && mapValue(native, "openai") === undefined && Reflect.get(registration, "streamSimple") === undefined
          && data(base, "stream") === baseStream && data(base, "streamSimple") === baseSimple
          && data(provider, "stream") === providerStream && data(provider, "streamSimple") === providerSimple
          && bodySHA(data(base, "stream")) === "e69cb89367796e89cbece84e9fca663fe694e32c9d062d0ba369d68b9dbacbf8"
          && bodySHA(data(base, "streamSimple")) === "c38778722135a771c079545bda99bfc134970490e70b692eee815b6a71230bb1"
          && bodySHA(data(provider, "stream")) === "6f9ae64062ae6df4c4730ae9222acc0ec933c8ee5ccf148851e7b4e24e5527db"
          && bodySHA(data(provider, "streamSimple")) === "7a4214b42554ac7177d1768e64e43ec728a96ade988dec1b5f30e73a184a6e90";
      } catch { return false; }
    };
  } catch { return () => false; }
}
interface OrdinaryHttpCapture {
  readonly mayObserveAuth: boolean;
  capture(prepared: unknown): OrdinaryHttpPreparation | undefined;
}
const unknownOrdinaryHttp: OrdinaryHttpCapture = { mayObserveAuth: false, capture: () => undefined };
function mapLacksKey(value: unknown, name: string): boolean {
  try { return Map.prototype.has.call(value, name) === false; } catch { return false; }
}
function ordinaryHttpCapture(bridge: ModelRuntimeBridge, model: unknown): OrdinaryHttpCapture {
  try {
    if (!object(model)) return unknownOrdinaryHttp;
    const providerId = data(model, "provider"), api = data(model, "api");
    if (typeof providerId !== "string" || !["openai-responses", "openai-completions"].includes(api as string)) return unknownOrdinaryHttp;
    const defaults = data(bridge.runtime, "defaultBuiltins"), builtins = data(bridge.runtime, "builtins");
    const native = data(bridge.runtime, "nativeExtensionProviders"), models = data(bridge.runtime, "models");
    if (!object(models) || ![defaults, builtins, native].every(map => mapLacksKey(map, providerId))) return unknownOrdinaryHttp;
    const provider: unknown = Reflect.apply(Reflect.get(models, "getProvider") as RuntimeMethod, models, [providerId]);
    const registration: unknown = Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]);
    if (!object(provider) || !object(registration) || Reflect.get(registration, "streamSimple") !== undefined) return unknownOrdinaryHttp;
    const stream = data(provider, "stream"), simple = data(provider, "streamSimple");
    if (bodySHA(simple) !== "7a4214b42554ac7177d1768e64e43ec728a96ade988dec1b5f30e73a184a6e90"
      || bodySHA(stream) !== "6f9ae64062ae6df4c4730ae9222acc0ec933c8ee5ccf148851e7b4e24e5527db") return unknownOrdinaryHttp;
    return { mayObserveAuth: true, capture(prepared) {
      try {
        bridge.assertCurrent();
        const currentRegistration: unknown = Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]);
        if (!object(prepared) || data(prepared, "provider") !== provider || currentRegistration !== registration
          || data(bridge.runtime, "defaultBuiltins") !== defaults || data(bridge.runtime, "builtins") !== builtins || data(bridge.runtime, "nativeExtensionProviders") !== native
          || ![defaults, builtins, native].every(map => mapLacksKey(map, providerId))
          || Reflect.get(registration, "streamSimple") !== undefined || data(provider, "stream") !== stream || data(provider, "streamSimple") !== simple) return undefined;
        const selected = data(prepared, "model"), options = data(prepared, "options"), baseUrl = data(registration, "baseUrl");
        if (!object(selected) || data(selected, "provider") !== providerId || data(selected, "api") !== api || typeof baseUrl !== "string" || data(selected, "baseUrl") !== baseUrl || !object(options)) return undefined;
        return { providerId, api: api as OrdinaryHttpPreparation["api"], baseUrl, provider, registration, options };
      } catch { return undefined; }
    } };
  } catch { return unknownOrdinaryHttp; }
}
/** Effective URL and identities are captured before the original authentication. */
function standardHttpCapture(bridge: ModelRuntimeBridge, model: unknown): OrdinaryHttpCapture {
  try {
    if (!object(model)) return unknownOrdinaryHttp;
    const providerId = data(model, "provider"), api = data(model, "api"), inputBaseUrl = data(model, "baseUrl");
    if (typeof providerId !== "string" || !["openai-responses", "openai-completions"].includes(api as string)) return unknownOrdinaryHttp;
    const models = data(bridge.runtime, "models");
    if (!object(models)) return unknownOrdinaryHttp;
    const provider: unknown = Reflect.apply(Reflect.get(models, "getProvider") as RuntimeMethod, models, [providerId]);
    const registration: unknown = Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]);
    if (!object(provider) || !object(registration)) return unknownOrdinaryHttp;
    const baseUrl = inputBaseUrl;
    if (typeof baseUrl !== "string") return unknownOrdinaryHttp;
    return { mayObserveAuth: true, capture(prepared) {
      try {
        bridge.assertCurrent();
        const current: unknown = Reflect.apply(Reflect.get(bridge.runtime, "getRegisteredProviderConfig") as RuntimeMethod, bridge.runtime, [providerId]);
        if (!object(prepared) || data(prepared, "provider") !== provider || current !== registration) return undefined;
        const selected = data(prepared, "model"), options = data(prepared, "options");
        if (!object(selected) || data(selected, "provider") !== providerId || data(selected, "api") !== api
          || data(selected, "baseUrl") !== baseUrl || !object(options)) return undefined;
        return { providerId, api: api as StandardHttpPreparation["api"], baseUrl, provider, registration, options };
      } catch { return undefined; }
    } };
  } catch { return unknownOrdinaryHttp; }
}
/** Decorates prepareRequest only. It must never unwrap/replace an E5 stream method. */
export function observeModelRequestPreparation(version: string, ctx: Parameters<typeof readModelRuntimeBridge>[1], observer: ModelRequestPreparationObserver): () => void {
  const bridge = readModelRuntimeBridge(version, ctx);
  const existing = preparations.get(bridge.runtime);
  if (existing) {
    if (Object.getOwnPropertyDescriptor(bridge.runtime, "prepareRequest")?.value !== existing.wrapper) throw new Error("Pi request preparation observer was replaced");
    existing.observers.set(observer, bridge);
    return () => { existing.observers.delete(observer); if (!existing.observers.size && preparations.get(bridge.runtime) === existing) { preparations.delete(bridge.runtime); existing.dispose(); } };
  }
  if (Object.getOwnPropertyDescriptor(bridge.runtime, "prepareRequest")) throw new Error("Pi request preparation already has a foreign owner");
  const original = bridge.original(bridge.runtime, "prepareRequest");
  if (bodySHA(original) !== "41b4d1109a7d7605192a6dcccfe26713fce45af0c48f45e00782e4ed96510eae") throw new Error("Pi request preparation capability unavailable");
  const observers = new Map([[observer, bridge]]);
  const wrapper: RuntimeMethod = function(this: unknown, ...args: unknown[]) {
    let selected: ModelRequestPreparationObserver | undefined;
    let selectedBridge: ModelRuntimeBridge | undefined;
    for (const [candidate, currentBridge] of observers) { try { currentBridge.assertCurrent(); selected = candidate; selectedBridge = currentBridge; } catch { /* retired context cannot poison a current observer */ } }
    if (!selected || !selectedBridge) return Reflect.apply(original, this, args);
    const receiver = this;
    let delegated = false;
    const prepare = (options: unknown) => {
      if (delegated) throw new Error("Pi request preparation was already delegated");
      delegated = true;
      return Reflect.apply(original, receiver, [args[0], options, ...args.slice(2)]);
    };
    try {
      const isStockOpenAIHttp = stockOpenAICapture(selectedBridge, args[0]);
      const ordinary = ordinaryHttpCapture(selectedBridge, args[0]);
      const standard = standardHttpCapture(selectedBridge, args[0]);
      return selected.run({ runtime: selectedBridge.runtime, manager: selectedBridge.manager, model: args[0], options: args[1], isStockOpenAIHttp,
        captureOrdinaryHttpPreparation: ordinary.capture, mayObserveOrdinaryHttpAuth: ordinary.mayObserveAuth,
        captureStandardHttpPreparation: standard.capture, mayObserveStandardHttpAuth: standard.mayObserveAuth }, prepare);
    } catch (error) {
      // A metadata failure before the original call must not replace SDK behavior.
      if (!delegated) return Reflect.apply(original, receiver, args);
      throw error;
    }
  };
  const restore = bridge.replace(bridge.runtime, "prepareRequest", wrapper);
  const state: PreparationObservers = { observers, wrapper, dispose: restore };
  preparations.set(bridge.runtime, state);
  return () => { observers.delete(observer); if (!observers.size && preparations.get(bridge.runtime) === state) { preparations.delete(bridge.runtime); restore(); } };
}
