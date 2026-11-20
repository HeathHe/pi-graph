/** Parent-process canonical Todo authority. Untrusted prompt context is a separate API. */
export interface TodoSourceHost {
  readonly cwd: string;
  readonly sessionId: string;
  readonly manager: object;
}
declare const sourceScopeBrand: unique symbol;
export interface TodoSourceScope { readonly [sourceScopeBrand]: true; }
export interface TodoSourceProvider {
  /** Host-owned services remain associated with this exact registration. */
  services?: object;
  capture(host: TodoSourceHost): object;
  assert(lease: object): void;
  host(lease: object): TodoSourceHost;
  run?<T>(lease: object, operation: () => T, scope: TodoSourceScope): T;
  subscribe?(lease:object,onInvalidated:()=>void):()=>void;
}
const key = Symbol.for("pi-graph-next:todo-source-provider/1");
interface Registration { readonly provider: TodoSourceProvider; readonly lifetime:AbortController; }
interface ScopeOwner { readonly registration: Registration; readonly lease: object; }
interface Registry { registration?: Registration; scopes?: WeakMap<object, ScopeOwner>; }
const globals = globalThis as typeof globalThis & Record<symbol, unknown>;
function registry(): Registry {
  return (globals[key] ??= {}) as Registry;
}
const scopes = registry().scopes ??= new WeakMap<object, ScopeOwner>();
export function registerTodoSourceProvider(provider: TodoSourceProvider): () => void {
  registry().registration?.lifetime.abort();
  const registration = Object.freeze({ provider, lifetime:new AbortController() });
  registry().registration = registration;
  return () => { registration.lifetime.abort();if (registry().registration === registration) registry().registration = undefined; };
}
/** Missing/foreign hosts do not authorize Todo, but do not disable non-Todo execution. */
export function captureTodoSourceScope(host: TodoSourceHost): TodoSourceScope | undefined {
  const registration = registry().registration;
  if (!registration || registration.lifetime.signal.aborted) return undefined;
  const provider = registration.provider;
  let lease: object;
  try { lease = provider.capture(host); } catch { return undefined; }
  const scope = Object.freeze({}) as TodoSourceScope;
  scopes.set(scope, { registration, lease });
  return scope;
}
export function assertTodoSourceScope(scope: unknown): asserts scope is TodoSourceScope {
  const owner = typeof scope === "object" && scope !== null ? scopes.get(scope) : undefined;
  if (!owner || registry().registration !== owner.registration || owner.registration.lifetime.signal.aborted) throw new Error("Todo source scope is unavailable or replaced.");
  owner.registration.provider.assert(owner.lease);
}
export function readTodoSourceHost(scope: unknown): TodoSourceHost {
  assertTodoSourceScope(scope);
  const owner = scopes.get(scope)!;
  return owner.registration.provider.host(owner.lease);
}
export function readTodoSourceServices(scope: unknown): object {
  assertTodoSourceScope(scope);
  const services = scopes.get(scope)!.registration.provider.services;
  if (!services) throw new Error("Todo canonical host services are unavailable.");
  return services;
}
/** Preserve the original issuer/registration through the owner's existing queue context. */
export function withTodoSourceScope<T>(scope: unknown, operation: () => T): T {
  assertTodoSourceScope(scope);
  const owner=scopes.get(scope)!;
  if(!owner.registration.provider.run) throw new Error("Todo source execution context is unavailable.");
  return owner.registration.provider.run(owner.lease,operation,scope);
}
/** Active waits only; callers must release this subscription in finally. */
export function subscribeTodoSourceInvalidation(scope:unknown,onInvalidated:()=>void):()=>void {
  assertTodoSourceScope(scope);
  const owner=scopes.get(scope)!;
  const signal=owner.registration.lifetime.signal;
  let released=false;
  const notify=()=>{if(!released)onInvalidated();};
  signal.addEventListener("abort",notify,{once:true});
  const dispose=owner.registration.provider.subscribe?.(owner.lease,notify);
  try{assertTodoSourceScope(scope);}catch{notify();}
  return ()=>{if(released)return;released=true;signal.removeEventListener("abort",notify);dispose?.();};
}
