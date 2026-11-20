import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withModelRequestOrigin, hasModelRequestGate, hasMeasuredModelUsage } from "./model-request-gate.ts";
import { assertLegacyModelCompletion } from "../goal-coordinator/state.ts";

/** Preserve original model/options; direct completions append their own real usage once. */
export async function completeOwnedModel(ctx: ExtensionContext, ...args: Parameters<typeof completeSimple>): ReturnType<typeof completeSimple> {
  return withModelRequestOrigin(ctx, async () => {
    if (!hasModelRequestGate(ctx)) { assertLegacyModelCompletion(ctx); return completeSimple(...args); }
    const manager = ctx.sessionManager, appendUsage: unknown = Reflect.get(manager, "appendUsage");
    if (typeof appendUsage !== "function") throw new Error("Direct model completion requires the original SDK usage journal writer");
    const response = await ctx.modelRegistry.streamSimple(...args).result();
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      try {
        if (hasMeasuredModelUsage(response.usage)) Reflect.apply(appendUsage, manager, ["flow_direct", response.provider, response.responseModel ?? response.model, response.usage]);
      } catch { /* Preserve the original provider/abort error; unresolved accounting remains unknown. */ }
    }
    if (response.stopReason === "aborted") {
      const signal = args[2]?.signal;
      if (signal?.aborted) signal.throwIfAborted();
      const error = new Error(response.errorMessage || "Model request was aborted");
      error.name = "AbortError";
      throw error;
    }
    if (response.stopReason === "error") throw new Error(response.errorMessage || "Model request failed");
    Reflect.apply(appendUsage, manager, ["flow_direct", response.provider, response.responseModel ?? response.model, response.usage]);
    return response;
  });
}

/** Capture before a model-producing callback's first await, not after config IO. */
export function modelOriginApi(pi: ExtensionAPI): ExtensionAPI {
  const wrap = (handler: (...args: unknown[]) => unknown, contextIndex: number) => (...args: unknown[]) =>
    withModelRequestOrigin(args[contextIndex] as ExtensionContext, () => handler(...args));
  return new Proxy(pi, { get(target, key) {
    if (key === "on") return (event: string, handler: (...args: unknown[]) => unknown) => Reflect.apply(target.on, target,
      [event, ["agent_end", "session_before_compact"].includes(event) ? wrap(handler, 1) : handler]);
    if (key === "registerCommand" || key === "registerShortcut") return (name: string, definition: { handler: (...args: unknown[]) => unknown }) =>
      Reflect.apply(Reflect.get(target, key), target, [name, { ...definition, handler: wrap(definition.handler, key === "registerCommand" ? 1 : 0) }]);
    const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value;
  } });
}
