import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { onBeforeCompact as goalBeforeCompact, onCompactionCancelled as goalCompactionCancelled, onCompact as goalCompact } from "../tools/goal.ts";
import { onCompactPlan, consumePlanCleanContextCompaction, applyPlanContextToCompaction, isPlanCleanContextCompactionInstructions } from "../tools/plan.ts";
import { COMPACTION_STATUS_KEY, createMaestroCompaction, persistMaestroCompactionKnowhow, runWithCompactionStatus, type WorkflowRecoveryIdentity } from "./maestro-compaction.ts";
import { buildNewContextRecoveryCapsule, newContextFirstKeptEntryId, type NewContextController } from "./new-context.ts";
import { commitProjectedCompactionInput, shouldCancelCompletedTurnThreshold, type createMidTurnAutoCompaction } from "./auto-compaction.ts";
import { CompactionArbiter, blocksNativeCompactionFallback, compactionRequestFromInstructions, isNativeFallbackCompactionInstructions, isProviderPressureCompactionTrigger, runObservedCompaction } from "./compaction-arbiter.ts";

/** Host-owned live state. Index must pass accessors, never a copied value. */
export interface CompactionHookState { preserveCompletedTurnFromNativeThreshold: boolean }
export interface RootCompactionHookState extends CompactionHookState {
  lastCompactionCancel: { reason: string; at: number; operationId?: number } | undefined;
}
export interface ChildCompactionHookPorts {
  state: CompactionHookState;
  compactionArbiter: CompactionArbiter;
  newContextController: NewContextController;
  autoCompaction: ReturnType<typeof createMidTurnAutoCompaction>;
}
export interface RootCompactionHookPorts extends ChildCompactionHookPorts {
  state: RootCompactionHookState;
  workflowRecoveryIdentity(): WorkflowRecoveryIdentity | undefined;
}

export function settleFailedCompaction(
  arbiter: Pick<CompactionArbiter, "complete">,
  event: { aborted: boolean; fromExtension: boolean },
): boolean {
  if (!event.fromExtension) return false;
  return arbiter.complete(event.aborted ? "cancel" : "error");
}

export function registerRootCompactionHooks(pi: Pick<ExtensionAPI, "on">, ports: RootCompactionHookPorts): void {
  const { state, compactionArbiter, newContextController, autoCompaction: midTurnAutoCompaction, workflowRecoveryIdentity } = ports;
pi.on("session_before_compact", async (event, ctx) => {
    const request = compactionRequestFromInstructions(event.customInstructions);
    const isRecoveryFallback = isNativeFallbackCompactionInstructions(event.customInstructions);
    const cancelCompletedTurnThreshold = shouldCancelCompletedTurnThreshold(
      event.reason,
      state.preserveCompletedTurnFromNativeThreshold,
      request !== undefined,
      Boolean(ctx.hasPendingMessages?.()),
      isRecoveryFallback,
      midTurnAutoCompaction.hasPendingTakeover(),
    );
    if (cancelCompletedTurnThreshold) {
      const retainNative = midTurnAutoCompaction.shouldRetainNativeThreshold(ctx);
      state.preserveCompletedTurnFromNativeThreshold = false;
      if (retainNative) {
        state.lastCompactionCancel = undefined;
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, "CTX CRITICAL → NATIVE");
          ctx.ui.notify(
            "Native threshold compaction retained because provider output headroom is exhausted.",
            "info",
          );
        } catch { /* native ownership remains authoritative */ }
      } else {
        const breakerPause = midTurnAutoCompaction.describeBreakerPause();
        state.lastCompactionCancel = {
          reason: breakerPause
            ? `completed-turn preservation (deferred; ${breakerPause})`
            : "completed-turn preservation (deferred to maestro settle)",
          at: Date.now(),
        };
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, breakerPause ? "CTX DEFERRED (BREAKER)" : "CTX DEFERRED → SETTLE");
          ctx.ui.notify(
            breakerPause
              ? `Native threshold compaction deferred: ${breakerPause}.`
              : "Native threshold compaction deferred: the turn completed cleanly; maestro compaction will run at agent settle.",
            "info",
          );
        } catch { /* status/notification are best-effort; cancellation stays authoritative */ }
        return { cancel: true };
      }
    }
    const observed = compactionArbiter.observeStart(
      request,
      event.signal,
    );
    if (!observed.allowed) {
      const activeOwner = compactionArbiter.currentOwner();
      const tombstone = compactionArbiter.timeoutTombstone();
      const reason = activeOwner
        ? `arbiter denied: a ${activeOwner} compaction is already active`
        : tombstone
          ? "arbiter denied: a timed-out compaction may still be settling"
          : "arbiter denied: stale or mismatched compaction request";
      state.lastCompactionCancel = {
        reason,
        at: Date.now(),
        operationId: observed.operationId,
      };
      try {
        ctx.ui.notify(
          activeOwner
            ? `Auto-compaction skipped: a ${activeOwner} compaction is already active.`
            : tombstone
              ? `Auto-compaction skipped: a timed-out compaction may still be settling (~${Math.ceil(tombstone.remainingMs / 1000)}s hold left).`
              : "Auto-compaction skipped: the compaction request no longer matches the active lease.",
          "info",
        );
      } catch { /* best-effort */ }
      return { cancel: true };
    }
    const providerPressureRecovery = isProviderPressureCompactionTrigger(observed.trigger);
    const failClosedRecovery = blocksNativeCompactionFallback(observed.trigger);
    try {
      const result = await runObservedCompaction(observed, async () => {
        goalBeforeCompact(ctx);
        if (observed.trigger?.owner === "new-context") {
          const newContextRequest = newContextController.consume(observed.trigger, ctx);
          if (!newContextRequest) {
            ctx.ui.notify("New-context reset was cancelled because its fenced payload was unavailable.", "warning");
            state.lastCompactionCancel = {
              reason: "new-context payload unavailable",
              at: Date.now(),
              operationId: observed.operationId,
            };
            return { cancel: true };
          }
          const newContext = {
            requestId: newContextRequest.requestId,
            source: newContextRequest.source,
            actorId: newContextRequest.actorId,
            ...(newContextRequest.carryForward ? { carryForward: newContextRequest.carryForward } : {}),
            ...(newContextRequest.handoff ? { handoff: newContextRequest.handoff } : {}),
            ...(newContextRequest.plan ? { plan: { ...newContextRequest.plan } } : {}),
            resourceUris: [...newContextRequest.resourceUris],
          };
          const compaction = await runWithCompactionStatus(event, ctx, () =>
            createMaestroCompaction(event, ctx, {
              getWorkflowIdentity: () => workflowRecoveryIdentity(),
              trigger: observed.trigger,
              newContext,
              summaryOverrideFactory: buildNewContextRecoveryCapsule,
              firstKeptEntryIdOverride: newContextFirstKeptEntryId(newContextRequest),
              failClosed: true,
            }), observed);
          return compaction?.compaction ? compaction : { cancel: true };
        }
        const cleanContextRequest = observed.trigger?.owner === "plan-handoff"
          && observed.trigger.reason === "clean-context"
          && isPlanCleanContextCompactionInstructions(event.customInstructions)
          ? consumePlanCleanContextCompaction()
          : undefined;
        if (observed.trigger?.owner === "plan-handoff" && observed.trigger.reason === "clean-context") {
          if (!cleanContextRequest) {
            ctx.ui.notify("Approved Plan context reset was cancelled because its payload was unavailable.", "warning");
            state.lastCompactionCancel = {
              reason: "plan clean-context payload unavailable",
              at: Date.now(),
              operationId: observed.operationId,
            };
            return { cancel: true };
          }
          const compaction = await runWithCompactionStatus(event, ctx, () =>
            createMaestroCompaction(event, ctx, {
              getWorkflowIdentity: () => workflowRecoveryIdentity(),
              trigger: observed.trigger,
              summaryOverride: cleanContextRequest.summary,
              firstKeptEntryIdOverride: cleanContextRequest.firstKeptEntryId,
            }), observed);
          return compaction?.compaction ? compaction : { cancel: true };
        }

        applyPlanContextToCompaction(
          event.preparation,
          buildSessionContext(event.branchEntries).messages,
        );

        const projected = await midTurnAutoCompaction.projectCompactionInput(event, ctx);
        commitProjectedCompactionInput(event, projected);
        return await runWithCompactionStatus(event, ctx, () =>
          createMaestroCompaction(event, ctx, {
            getWorkflowIdentity: () => workflowRecoveryIdentity(),
            trigger: observed.trigger,
            summaryInputTokens: projected.estimatedInputTokens,
            failClosed: providerPressureRecovery,
          }), observed);
      });
      if (result?.cancel) {
        observed.finalize("cancel");
        if (state.lastCompactionCancel?.operationId !== observed.operationId) {
          state.lastCompactionCancel = {
            reason: providerPressureRecovery
              ? "provider-pressure recovery failed (fail-closed; native fallback blocked)"
              : "maestro compaction declined (see notification)",
            at: Date.now(),
            operationId: observed.operationId,
          };
        }
        if (providerPressureRecovery) {
          try { goalCompactionCancelled(ctx); } catch { /* cancellation remains authoritative */ }
        } else {
          goalCompactionCancelled(ctx);
        }
      }
      return result;
    } catch (error) {
      observed.finalize("error");
      if (failClosedRecovery) {
        try { goalCompactionCancelled(ctx); } catch { /* cancellation remains authoritative */ }
        const newContextRecovery = observed.trigger?.owner === "new-context";
        try {
          ctx.ui.notify(
            `${newContextRecovery ? "New-context reset" : "Provider-pressure compaction"} failed; native fallback was blocked: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } catch { /* cancellation remains authoritative */ }
        state.lastCompactionCancel = {
          reason: newContextRecovery
            ? "new-context reset failed (fail-closed; native fallback blocked)"
            : "provider-pressure recovery failed (fail-closed; native fallback blocked)",
          at: Date.now(),
          operationId: observed.operationId,
        };
        return { cancel: true };
      }
      goalCompactionCancelled(ctx);
      ctx.ui.notify(
        `Compaction failed; falling back to Pi native compaction: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  });

pi.on("session_compact", async (event, ctx) => {
    const completedOwner = compactionArbiter.currentOwner();
    if (!midTurnAutoCompaction.onCompact(completedOwner, ctx)) return;
    compactionArbiter.complete("success");
    // Clear the non-persistent Plan replacement before any async subsystem can
    // enqueue a continuation or fail. The persisted compaction is now canonical.
    onCompactPlan(ctx);
    if (newContextController.hasPending()) {
      queueMicrotask(() => {
        void newContextController.onCompactionSettled(ctx).catch((error) => {
          ctx.ui.notify(
            `Deferred new-context settlement failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      });
    }
    try {
      await persistMaestroCompactionKnowhow(event, ctx);
    } catch (error) {
      ctx.ui.notify(
        `Compaction checkpoint was saved in the session but the knowhow copy failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    await goalCompact(event, ctx, { deferContinuation: true });
  });

pi.on("session_compact_failed", (event, ctx) => {
    state.preserveCompletedTurnFromNativeThreshold = false;
    if (!settleFailedCompaction(compactionArbiter, event)) return;
    if (newContextController.hasPending()) {
      queueMicrotask(() => {
        void newContextController.onCompactionSettled(ctx).catch((error) => {
          ctx.ui.notify(
            `Deferred new-context settlement after failure failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      });
    }
    state.lastCompactionCancel = {
      reason: event.aborted
        ? `${event.reason} compaction aborted`
        : event.errorMessage ?? `${event.reason} compaction failed`,
      at: Date.now(),
    };
    try {
      goalCompactionCancelled(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Goal state rollback after compaction failure failed: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}

export function registerChildCompactionHooks(pi: Pick<ExtensionAPI, "on">, ports: ChildCompactionHookPorts): void {
  const { state, compactionArbiter, newContextController, autoCompaction } = ports;
pi.on("session_before_compact", async (event, ctx) => {
    const request = compactionRequestFromInstructions(event.customInstructions);
    const isRecoveryFallback = isNativeFallbackCompactionInstructions(event.customInstructions);
    const cancelCompletedTurnThreshold = shouldCancelCompletedTurnThreshold(
      event.reason,
      state.preserveCompletedTurnFromNativeThreshold,
      request !== undefined,
      Boolean(ctx.hasPendingMessages?.()),
      isRecoveryFallback,
      autoCompaction.hasPendingTakeover(),
    );
    if (cancelCompletedTurnThreshold) {
      const retainNative = autoCompaction.shouldRetainNativeThreshold(ctx);
      state.preserveCompletedTurnFromNativeThreshold = false;
      if (retainNative) {
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, "CTX CRITICAL → NATIVE");
          ctx.ui.notify(
            "Native threshold compaction retained because provider output headroom is exhausted.",
            "info",
          );
        } catch { /* native ownership remains authoritative */ }
      } else {
        const breakerPause = autoCompaction.describeBreakerPause();
        try {
          ctx.ui.setStatus(COMPACTION_STATUS_KEY, breakerPause ? "CTX DEFERRED (BREAKER)" : "CTX DEFERRED → SETTLE");
          ctx.ui.notify(
            breakerPause
              ? `Native threshold compaction deferred: ${breakerPause}.`
              : "Native threshold compaction deferred: the turn completed cleanly; maestro compaction will run at agent settle.",
            "info",
          );
        } catch { /* status/notification are best-effort; cancellation stays authoritative */ }
        return { cancel: true };
      }
    }
    const observed = compactionArbiter.observeStart(request, event.signal);
    if (!observed.allowed) {
      const activeOwner = compactionArbiter.currentOwner();
      const tombstone = compactionArbiter.timeoutTombstone();
      try {
        ctx.ui.notify(
          activeOwner
            ? `Auto-compaction skipped: a ${activeOwner} compaction is already active.`
            : tombstone
              ? `Auto-compaction skipped: a timed-out compaction may still be settling (~${Math.ceil(tombstone.remainingMs / 1000)}s hold left).`
              : "Auto-compaction skipped: the compaction request no longer matches the active lease.",
          "info",
        );
      } catch { /* best-effort */ }
      return { cancel: true };
    }
    const providerPressureRecovery = isProviderPressureCompactionTrigger(observed.trigger);
    const failClosedRecovery = blocksNativeCompactionFallback(observed.trigger);
    try {
      if (observed.trigger?.owner === "new-context") {
        const newContextRequest = newContextController.consume(observed.trigger, ctx);
        if (!newContextRequest) {
          ctx.ui.notify("Child new-context reset was cancelled because its fenced payload was unavailable.", "warning");
          observed.finalize("cancel");
          return { cancel: true };
        }
        const newContext = {
          requestId: newContextRequest.requestId,
          source: newContextRequest.source,
          actorId: newContextRequest.actorId,
          ...(newContextRequest.carryForward ? { carryForward: newContextRequest.carryForward } : {}),
          ...(newContextRequest.handoff ? { handoff: newContextRequest.handoff } : {}),
          ...(newContextRequest.plan ? { plan: { ...newContextRequest.plan } } : {}),
          resourceUris: [...newContextRequest.resourceUris],
        };
        const result = await runObservedCompaction(observed, () =>
          createMaestroCompaction(event, ctx, {
            trigger: observed.trigger,
            newContext,
            recoveryState: newContextRequest.recoveryState,
            summaryOverrideFactory: buildNewContextRecoveryCapsule,
            firstKeptEntryIdOverride: newContextFirstKeptEntryId(newContextRequest),
            failClosed: true,
          }));
        if (result?.cancel) observed.finalize("cancel");
        return result;
      }
      const projected = await autoCompaction.projectCompactionInput(event, ctx);
      commitProjectedCompactionInput(event, projected);
      const result = await runObservedCompaction(observed, () =>
        createMaestroCompaction(event, ctx, {
          trigger: observed.trigger,
          summaryInputTokens: projected.estimatedInputTokens,
          failClosed: providerPressureRecovery,
        }));
      if (result?.cancel) observed.finalize("cancel");
      return result;
    } catch (error) {
      observed.finalize("error");
      if (failClosedRecovery) {
        const newContextRecovery = observed.trigger?.owner === "new-context";
        try {
          ctx.ui.notify(
            `Child ${newContextRecovery ? "new-context reset" : "provider-pressure compaction"} failed; native fallback was blocked: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        } catch { /* cancellation remains authoritative */ }
        return { cancel: true };
      }
      ctx.ui.notify(
        `Child compaction failed; falling back to Pi native compaction: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
      return undefined;
    }
  });

pi.on("session_compact", (_event, ctx) => {
    const completedOwner = compactionArbiter.currentOwner();
    if (!autoCompaction.onCompact(completedOwner, ctx)) return;
    compactionArbiter.complete("success");
    if (newContextController.hasPending()) {
      queueMicrotask(() => {
        void newContextController.onCompactionSettled(ctx).catch((error) => {
          ctx.ui.notify(
            `Deferred child new-context settlement failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      });
    }
  });

pi.on("session_compact_failed", (event, ctx) => {
    state.preserveCompletedTurnFromNativeThreshold = false;
    if (!settleFailedCompaction(compactionArbiter, event)) return;
    if (newContextController.hasPending()) {
      queueMicrotask(() => {
        void newContextController.onCompactionSettled(ctx).catch((error) => {
          ctx.ui.notify(
            `Deferred child new-context settlement after failure failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        });
      });
    }
  });
}
