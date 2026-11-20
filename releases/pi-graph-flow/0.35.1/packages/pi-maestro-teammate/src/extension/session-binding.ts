import type { TeammateState, SessionProjectionIdentity } from "../shared/types.ts";
import type { CompletionDeliveryEnvelope, CompletionSessionBinding } from "../completion-outbox/coordinator.ts";

export type RootSessionFence = Readonly<{
  generation: number;
  sessionId: string | null;
  workspaceId: string | undefined;
  sourceId: string | undefined;
  baseCwd: string;
}>;

export interface SessionBindingContext {
  cwd: string;
  sessionManager?: {
    getSessionId(): string;
    getEntries?(): readonly unknown[];
  };
}

export interface SessionBindingPorts {
  workspaceIdForCwd(cwd: string): string;
  completionWorkspaceId(cwd: string): string;
  completionWorkspaceIdentity(cwd: string): { workspaceId: string; legacyWorkspaceIds: readonly string[] };
  desktopTargetIdentityForCurrentSession(sessionId: string | null, cwd: string): TeammateState["desktopTargetIdentity"];
  bindRootDelivery(workspaceId: string, sessionId: string | null): void;
  resetAdvisorSession(cwd: string): void;
  refreshObservation(): void;
  markWorkspacePeerDirty(): void;
  reconcileSettled(options: { preserveExact: boolean }): void;
  bindTurnRecorder(): void;
  rebuildTurnLedger(entries: readonly unknown[]): void;
  initializeRuntimeReadModel(cwd: string, sourceId: string): unknown;
  bindCompletion(binding: CompletionSessionBinding): Promise<void>;
  sendCompletion(envelope: CompletionDeliveryEnvelope, journalOnly?: true): boolean;
  reportCompletionBindError(error: unknown): void;
  clearMonitorSubscriptions(): void;
  abortAdvisorReview(reason: string): void;
}

/** One adapter over the existing root state; no independent registry or run owner. */
export function createSessionBinding(state: TeammateState, ports: SessionBindingPorts) {
  const capture = (): RootSessionFence => Object.freeze({
    generation: state.sessionGeneration ?? 0,
    sessionId: state.currentSessionId,
    workspaceId: state.currentWorkspaceId,
    sourceId: state.currentSourceId,
    baseCwd: state.baseCwd,
  });
  const owns = (fence: RootSessionFence): boolean =>
    (state.sessionGeneration ?? 0) === fence.generation
    && state.currentSessionId === fence.sessionId
    && state.currentWorkspaceId === fence.workspaceId
    && state.currentSourceId === fence.sourceId
    && state.baseCwd === fence.baseCwd;
  const projection = (fence: RootSessionFence): SessionProjectionIdentity | undefined =>
    fence.sessionId && fence.workspaceId && fence.sourceId && fence.generation > 0
      ? { workspaceId: fence.workspaceId, sessionId: fence.sessionId, sourceId: fence.sourceId, generation: fence.generation }
      : undefined;

  function start(reason: string | undefined, ctx: SessionBindingContext): void {
    state.settlementOwner = undefined;
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    state.currentSessionId = ctx.sessionManager?.getSessionId() ?? null;
    state.baseCwd = ctx.cwd;
    ports.bindRootDelivery(ports.workspaceIdForCwd(ctx.cwd), state.currentSessionId);
    state.desktopTargetIdentity = ports.desktopTargetIdentityForCurrentSession(state.currentSessionId, ctx.cwd);
    state.desktopTargetSessionGeneration = state.desktopTargetIdentity ? state.sessionGeneration : undefined;
    ports.resetAdvisorSession(ctx.cwd);
    state.currentWorkspaceId = ports.completionWorkspaceId(ctx.cwd);
    state.currentSourceId = state.currentSessionId ?? undefined;
    ports.refreshObservation();
    ports.markWorkspacePeerDirty();
    ports.reconcileSettled({
      preserveExact: reason === "resume" || reason === "reload",
    });
    ports.bindTurnRecorder();
    ports.rebuildTurnLedger(ctx.sessionManager?.getEntries?.() ?? []);
    if (state.currentSourceId) void ports.initializeRuntimeReadModel(ctx.cwd, state.currentSourceId);
    const completionSessionId = state.currentSessionId;
    const boundCompletionWorkspace = ports.completionWorkspaceIdentity(ctx.cwd);
    const boundCompletionWorkspaceId = boundCompletionWorkspace.workspaceId;
    const completionGeneration = state.sessionGeneration;
    if (completionSessionId) {
      const completionManager = ctx.sessionManager;
      const completionFence = capture();
      void ports.bindCompletion({
        target: {
          workspaceId: boundCompletionWorkspaceId,
          sessionId: completionSessionId,
        },
        legacyWorkspaceIds: boundCompletionWorkspace.legacyWorkspaceIds,
        // Journal-only SDK sends persist without the extension message_end hook.
        // Read the same live session journal on each existing reconciliation.
        get entries() {
          if (!completionManager || !owns(completionFence) || ctx.sessionManager !== completionManager
            || completionManager.getSessionId() !== completionSessionId
            || ports.workspaceIdForCwd(state.baseCwd) !== boundCompletionWorkspaceId) return [];
          return completionManager.getEntries?.() ?? [];
        },
        send(envelope: CompletionDeliveryEnvelope, journalOnly?: true) {
          return state.currentSessionId === completionSessionId
            && state.sessionGeneration === completionGeneration
            && ports.workspaceIdForCwd(state.baseCwd) === boundCompletionWorkspaceId
            // deliverAs: "steer" (not "followUp") so a replayed teammate-complete
            // is drained at the next turn boundary (right after the current tool
            // call finishes) instead of waiting for the agent to fully stop.
            // pi-core drains the steer queue every turn_end (agent-loop.js),
            // whereas followUp only drains when the agent would otherwise stop.
            && ports.sendCompletion(envelope, journalOnly);
        },
      }).catch((error) => {
        ports.reportCompletionBindError(error);
      });
    }
  }

  function compact(ctx: SessionBindingContext): void {
    const previousFence = capture();
    const nextSessionId = ctx.sessionManager?.getSessionId() ?? null;
    if (state.currentSessionId !== nextSessionId || state.baseCwd !== ctx.cwd) {
      state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    }
    state.baseCwd = ctx.cwd;
    state.currentSessionId = nextSessionId;
    state.currentWorkspaceId = ports.completionWorkspaceId(ctx.cwd);
    state.currentSourceId = state.currentSessionId ?? undefined;
    ports.refreshObservation();
    const currentDesktopTarget = ports.desktopTargetIdentityForCurrentSession(state.currentSessionId, ctx.cwd);
    state.desktopTargetIdentity = currentDesktopTarget;
    state.desktopTargetSessionGeneration = currentDesktopTarget ? state.sessionGeneration : undefined;
    ports.markWorkspacePeerDirty();
    const projectionChanged = !owns(previousFence);
    if (projectionChanged) {
      ports.clearMonitorSubscriptions();
      ports.abortAdvisorReview("Advisor session changed during compaction.");
      ports.reconcileSettled({ preserveExact: true });
      ports.bindTurnRecorder();
      void ports.initializeRuntimeReadModel(ctx.cwd, state.currentSourceId ?? "");
    }
  }

  function captureSettlementOwner(): void {
    const outgoingFence = capture();
    state.settlementOwner = projection(outgoingFence);
  }

  function invalidate(): void {
    state.sessionGeneration = (state.sessionGeneration ?? 0) + 1;
    state.currentSessionId = null;
    state.desktopTargetIdentity = undefined;
    state.desktopTargetSessionGeneration = undefined;
    ports.markWorkspacePeerDirty();
  }

  return { capture, owns, projection, start, compact, captureSettlementOwner, invalidate };
}
