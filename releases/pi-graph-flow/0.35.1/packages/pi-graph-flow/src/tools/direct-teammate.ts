import { captureTodoSourceExecution } from "../task-workflow/commands.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTeammateDirectChildRequestHandler } from "pi-maestro-teammate/v1/extension";
import { createModelCatalogSnapshot, refreshModelRegistry } from "pi-maestro-teammate/v1/model-routing";
import type { RunTeammateOptions } from "pi-maestro-teammate/v1/execution";

export type DirectTeammateRunOverrides = Omit<RunTeammateOptions, "onChildRequest">;

/** Capture at the original caller, before discovery, queueing or model selection yields. */
export function captureDirectTodoSourceScope(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">) {
  return captureTodoSourceExecution(ctx).sourceScope;
}

/**
 * Build the parent-authoritative options required by direct runTeammate/runGraph callers.
 * Keeping this in one factory prevents a direct runtime from silently dropping child requests.
 */
export async function createDirectTeammateRunOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  overrides: DirectTeammateRunOverrides = { baseCwd: ctx.cwd },
): Promise<RunTeammateOptions> {
  // Freeze source before registry discovery can yield; partial contexts keep non-Todo execution.
  const todoSourceScope = "todoSourceScope" in overrides ? overrides.todoSourceScope : captureDirectTodoSourceScope(ctx);
  await refreshModelRegistry(ctx);
  return {
    ...overrides,
    todoSourceScope,
    baseCwd: overrides.baseCwd || ctx.cwd,
    modelCapabilities: overrides.modelCapabilities
      ?? createModelCatalogSnapshot(ctx.modelRegistry.getAvailable()).models,
    onChildRequest: createTeammateDirectChildRequestHandler(pi, ctx),
  };
}
