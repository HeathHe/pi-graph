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
    completionWorkspaceIdentity(cwd: string): {
        workspaceId: string;
        legacyWorkspaceIds: readonly string[];
    };
    desktopTargetIdentityForCurrentSession(sessionId: string | null, cwd: string): TeammateState["desktopTargetIdentity"];
    bindRootDelivery(workspaceId: string, sessionId: string | null): void;
    resetAdvisorSession(cwd: string): void;
    refreshObservation(): void;
    markWorkspacePeerDirty(): void;
    reconcileSettled(options: {
        preserveExact: boolean;
    }): void;
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
export declare function createSessionBinding(state: TeammateState, ports: SessionBindingPorts): {
    capture: () => RootSessionFence;
    owns: (fence: RootSessionFence) => boolean;
    projection: (fence: RootSessionFence) => SessionProjectionIdentity | undefined;
    start: (reason: string | undefined, ctx: SessionBindingContext) => void;
    compact: (ctx: SessionBindingContext) => void;
    captureSettlementOwner: () => void;
    invalidate: () => void;
};
