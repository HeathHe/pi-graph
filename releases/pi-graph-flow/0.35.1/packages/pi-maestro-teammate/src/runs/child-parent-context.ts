import type { TodoSourceScope } from "./todo-source-context.ts";
/** Never serialized into child IPC. Only the actual parent relay can attach this argument. */
export interface ChildTodoParentMetadata {
  readonly sourceScope?: TodoSourceScope;
  /** Actual attempt closure, never reconstructed from child JSON. */
  readonly modelBudget?: {
    open(): Promise<{ nonce: string; kind: "none" | "declared"; correlationId: string; runtimeGeneration: number | null; nativeInvocationId: string }>;
    authorizeNone(nonce: string, requestId: string): Promise<void>;
    prepare(nonce: string, requestId: string, control?: { signal?: AbortSignal }): Promise<{ claim: string }>;
    abandon?(nonce: string, claim: string): Promise<void>;
    mark(nonce: string, claim: string, entryId: string, digest: string): Promise<void>;
  };
  readonly correlationId: string;
  readonly runtimeGeneration: number | null;
  readonly signal?: AbortSignal;
  readonly isCurrent: () => boolean;
}
declare const parentContextBrand: unique symbol;
export interface ChildTodoParentContext { readonly [parentContextBrand]: true; }
const registryKey = Symbol.for("pi-graph:child-parent-context-issuance:v1");
const registry = globalThis as typeof globalThis & { [registryKey]?: WeakMap<object, ChildTodoParentMetadata> };
// Original opaque objects may cross independent plugin module graphs in one parent.
const issued = registry[registryKey] ??= new WeakMap<object, ChildTodoParentMetadata>();
export function createChildTodoParentContext(metadata: ChildTodoParentMetadata): ChildTodoParentContext {
  const context = Object.freeze({}) as ChildTodoParentContext;
  issued.set(context, Object.freeze({ ...metadata }));
  return context;
}
/** A JSON/clone/cid/native UI snapshot cannot substitute for a live invocation. */
export function readChildTodoParentContext(context: unknown): ChildTodoParentMetadata {
  const metadata = typeof context === "object" && context !== null ? issued.get(context) : undefined;
  if (!metadata) throw new Error("Todo parent invocation is unavailable or unverified.");
  if (metadata.signal?.aborted) throw new Error("Todo parent invocation was cancelled.");
  if (!metadata.isCurrent()) throw new Error("Todo parent invocation is no longer current.");
  return metadata;
}
