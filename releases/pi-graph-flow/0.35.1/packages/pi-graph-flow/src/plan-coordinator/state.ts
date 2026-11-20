/** Sole volatile Plan owner. Durable documents and approval remain in PlanStore. */
import type { PlanStore, LoadedPlan } from "../tools/plan-store.ts";
import type { RefineSession, RefineAppliesAs, RefineRole, RefinePanelResult } from "../tools/plan-refine.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Mode, PlanContext, PlanToolDetails, PlanOperationIdentity, PlanHandoffRequestIdentity, PlanCompactHandoff, PlanCleanContextCompactionRequest, PlanContextReplacement } from "./types.ts";
import type { PlanExecutionChoice, PlanWorkflowBinding } from "../tools/plan-store.ts";

export interface PlanReadIdentity { readonly lifecycleGeneration: number; readonly sessionId: string; readonly storeKey: string; readonly store: PlanStore; }
interface PlanArtifactBranchRead {
  identity: PlanReadIdentity;
  epoch: number;
  branch: readonly { id: string; parentId: string | null }[];
  knownEntries: Set<string>;
}
export class PlanState {
  #mode: Mode = "act";
  #artifactReadsOpen = false;
  #artifactReadEpoch = 0;
  #artifactReadManager: PlanContext["sessionManager"] | undefined;
  #artifactSourceRead: PlanReadIdentity | undefined;
  #currentStore: PlanStore | undefined;
  #currentStoreKey = "";
  #latestPlan: string | undefined;
  #latestRevision = 0;
  #latestStatus: PlanToolDetails["status"] = "empty";
  #latestHandoffKey: string | undefined;
  #latestApprovedPath: string | undefined;
  #latestApprovedChecksum: string | undefined;
  #latestExecution: PlanExecutionChoice | undefined;
  #latestWorkflowBinding: PlanWorkflowBinding | undefined;
  #latestArtifactAvailable = false;
  #awaitingAction = false;
  #pendingPlanExitReminder: string | undefined;
  #pendingPlanEnterNote: string | undefined;
  #planLifecycleGeneration = 0;
  #nextPlanHandoffRequestId = 0;
  #nextPlanOperationId = 0;
  #activePlanOperation: PlanOperationIdentity | undefined;
  #activePlanHandoffRequest: PlanHandoffRequestIdentity | undefined;
  #pendingPlanCompactHandoff: PlanCompactHandoff | undefined;
  #activePlanCompactHandoff: PlanCompactHandoff | undefined;
  #planCompactionSettlementTimer: ReturnType<typeof setImmediate> | undefined;
  #pendingCleanContextCompaction: PlanCleanContextCompactionRequest | undefined;
  #planContextReplacement: PlanContextReplacement | undefined;
  #refineSession: RefineSession | undefined;
  #refineSessionRevision = -1;
  #refineLatestOutput: string | undefined;
  #refineLatestRole: RefineRole | undefined;
  #refineLatestAppliesAs: RefineAppliesAs | undefined;
  #refineLatestRoleLabel: string | undefined;
  readonly #operationStores = new WeakMap<PlanOperationIdentity, PlanStore>();
  readonly #handoffWaiting = new WeakMap<PlanCompactHandoff, boolean>();

  get mode() { return this.#mode; }
  /** Store is an internal capability; public queries never return it. */
  get currentStore() { return this.#currentStore; }
  get currentStoreKey() { return this.#currentStoreKey; }
  get latestPlan() { return this.#latestPlan; }
  get latestRevision() { return this.#latestRevision; }
  get latestStatus() { return this.#latestStatus; }
  get latestHandoffKey() { return this.#latestHandoffKey; }
  get latestApprovedPath() { return this.#latestApprovedPath; }
  get latestApprovedChecksum() { return this.#latestApprovedChecksum; }
  get latestExecution() { return this.#latestExecution && structuredClone(this.#latestExecution); }
  get latestWorkflowBinding() { return this.#latestWorkflowBinding && structuredClone(this.#latestWorkflowBinding); }
  get latestArtifactAvailable() { return this.#latestArtifactAvailable; }
  get awaitingAction() { return this.#awaitingAction; }
  get pendingPlanExitReminder() { return this.#pendingPlanExitReminder; }
  get pendingPlanEnterNote() { return this.#pendingPlanEnterNote; }
  get planLifecycleGeneration() { return this.#planLifecycleGeneration; }
  get activePlanOperation() { return this.#activePlanOperation; }
  get activePlanHandoffRequest() { return this.#activePlanHandoffRequest; }
  get pendingPlanCompactHandoff() { return this.#pendingPlanCompactHandoff; }
  get activePlanCompactHandoff() { return this.#activePlanCompactHandoff; }
  get hasSettlementTimer() { return this.#planCompactionSettlementTimer !== undefined; }
  get pendingCleanContextCompaction() { return this.#pendingCleanContextCompaction && structuredClone(this.#pendingCleanContextCompaction); }
  get planContextReplacement() { return this.#planContextReplacement && structuredClone(this.#planContextReplacement); }
  get refineSession() { return this.#refineSession && structuredClone(this.#refineSession); }
  get refineSessionRevision() { return this.#refineSessionRevision; }
  get refineLatestOutput() { return this.#refineLatestOutput; }
  get refineLatestRole() { return this.#refineLatestRole; }
  get refineLatestAppliesAs() { return this.#refineLatestAppliesAs; }
  get refineLatestRoleLabel() { return this.#refineLatestRoleLabel; }

  getOrBindStore(ctx: PlanContext, create: () => PlanStore): PlanStore {
    const operation = this.#activePlanOperation;
    const generation = this.#planLifecycleGeneration, sessionId = ctx.sessionManager.getSessionId();
    const key = `${ctx.cwd}\0${sessionId}`;
    if (this.#currentStore && this.#currentStoreKey === key) return this.#currentStore;
    const store = create();
    if (operation !== this.#activePlanOperation || generation !== this.#planLifecycleGeneration || sessionId !== ctx.sessionManager.getSessionId() || key !== `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`) throw new Error("Plan store creation was superseded");
    this.#currentStore = store; this.#currentStoreKey = key;
    return store;
  }
  releaseFailedStore(): void { this.#currentStore = undefined; this.#currentStoreKey = ""; }
  canReadContext(ctx: PlanContext): boolean {
    try {
      const key = `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`;
      if (this.#currentStore) return key === this.#currentStoreKey;
      return !this.#activePlanOperation || this.planOperationMatchesContext(ctx, this.#activePlanOperation);
    } catch { return false; }
  }
  captureRead(ctx: PlanContext, store: PlanStore): PlanReadIdentity {
    return Object.freeze({ lifecycleGeneration: this.#planLifecycleGeneration, sessionId: ctx.sessionManager.getSessionId(), storeKey: `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`, store });
  }
  isCurrentRead(ctx: PlanContext, identity: PlanReadIdentity): boolean {
    try { return identity.lifecycleGeneration === this.#planLifecycleGeneration && identity.store === this.#currentStore && identity.storeKey === this.#currentStoreKey && identity.sessionId === ctx.sessionManager.getSessionId() && identity.storeKey === `${ctx.cwd}\0${identity.sessionId}`; } catch { return false; }
  }
  /** Narrow artifact fence; does not move Plan/UI reset or claim I/O drained. */
  fenceArtifactReads(): void { this.#artifactReadsOpen = false; this.#artifactReadManager = undefined; this.#artifactSourceRead = undefined; this.#artifactReadEpoch++; }
  get artifactReadEpoch(): number { return this.#artifactReadEpoch; }
  openArtifactReads(ctx: PlanContext, identity: PlanReadIdentity, epoch: number): void {
    if (epoch === this.#artifactReadEpoch && this.isCurrentRead(ctx, identity)) { this.#artifactReadManager = ctx.sessionManager; this.#artifactSourceRead = identity; this.#artifactReadsOpen = true; }
  }
  captureArtifactRead(ctx: PlanContext): PlanArtifactBranchRead {
    if (!this.#artifactReadsOpen || ctx.sessionManager !== this.#artifactReadManager || !this.#artifactSourceRead || !this.isCurrentRead(ctx, this.#artifactSourceRead) || !this.#currentStore || !this.canReadContext(ctx)) throw new Error("Current Plan artifact source is unavailable.");
    const branch = ctx.sessionManager.getBranch().map(entry => ({ id: entry.id, parentId: entry.parentId ?? null }));
    if ((branch.at(-1)?.id ?? null) !== ctx.sessionManager.getLeafId()) throw new Error("Plan branch is inconsistent.");
    return { identity: this.captureRead(ctx, this.#currentStore), epoch: this.#artifactReadEpoch, branch, knownEntries: new Set(ctx.sessionManager.getEntries().map(entry => entry.id)) };
  }
  isCurrentArtifactRead(ctx: PlanContext, read: PlanArtifactBranchRead): boolean {
    try {
      if (!this.#artifactReadsOpen || ctx.sessionManager !== this.#artifactReadManager || read.epoch !== this.#artifactReadEpoch || !this.isCurrentRead(ctx, read.identity)) return false;
      const branch = ctx.sessionManager.getBranch();
      if (branch.length < read.branch.length || (branch.at(-1)?.id ?? null) !== ctx.sessionManager.getLeafId()) return false;
      for (let i = 0; i < branch.length; i++) {
        const entry = branch[i]!, old = read.branch[i];
        if ((entry.parentId ?? null) !== (i === 0 ? null : branch[i - 1]!.id)) return false;
        if (old ? entry.id !== old.id || (entry.parentId ?? null) !== old.parentId : read.knownEntries.has(entry.id)) return false;
      }
      // Extend the observed prefix only for genuinely new, linearly appended
      // entries. Switching to an existing sibling or resetting to an earlier
      // anchor fails. Empty initial branches can only grow new root entries.
      read.branch = branch.map(entry => ({ id: entry.id, parentId: entry.parentId ?? null }));
      read.knownEntries = new Set(ctx.sessionManager.getEntries().map(entry => entry.id));
      return true;
    } catch { return false; }
  }
  publishArtifactAvailability(ctx: PlanContext, identity: PlanReadIdentity, available: boolean): boolean {
    if (!this.isCurrentRead(ctx, identity)) return false;
    this.#latestArtifactAvailable = available; return true;
  }
  observeSavedArtifact(hasContent: boolean): void { this.#latestArtifactAvailable ||= hasContent; }
  applyLoadedPlan(loaded: LoadedPlan): void {
    this.#latestPlan = loaded.markdown || undefined;
    this.#latestRevision = loaded.manifest.revision;
    this.#latestStatus = loaded.markdown ? loaded.manifest.status : "empty";
    this.#latestHandoffKey = loaded.manifest.handoffKey;
    this.#latestApprovedPath = loaded.manifest.approvedPath;
    this.#latestApprovedChecksum = loaded.manifest.approvedChecksum;
    this.#latestExecution = loaded.manifest.execution && structuredClone(loaded.manifest.execution);
    this.#latestWorkflowBinding = loaded.manifest.workflowBinding && structuredClone(loaded.manifest.workflowBinding);
    this.#latestArtifactAvailable ||= Boolean(loaded.markdown.trim()) || loaded.manifest.approvals.length > 0;
    this.#awaitingAction = loaded.manifest.status === "approved" && Boolean(loaded.markdown.trim());
  }
  clearPlan(): void {
    this.#latestPlan = undefined; this.#latestRevision = 0; this.#latestStatus = "empty";
    this.#latestHandoffKey = undefined; this.#latestApprovedPath = undefined; this.#latestApprovedChecksum = undefined;
    this.#latestExecution = undefined; this.#latestWorkflowBinding = undefined; this.#latestArtifactAvailable = false;
    this.resetRefinement(); this.#awaitingAction = false;
  }
  enterPlanning(note: string): void { this.#pendingPlanExitReminder = undefined; this.#pendingPlanEnterNote = note; this.#mode = "plan"; }
  leavePlanning(): void { this.#mode = "act"; this.#pendingPlanEnterNote = undefined; }
  notePlanExit(note: string): void { this.#pendingPlanExitReminder = note; }
  consumeEnterNote(): void { this.#pendingPlanEnterNote = undefined; }
  consumeExitReminder(): void { this.#pendingPlanExitReminder = undefined; }
  beginPlanOperation(ctx: PlanContext): PlanOperationIdentity {
    const sessionId = ctx.sessionManager.getSessionId(), storeKey = `${ctx.cwd}\0${sessionId}`;
    const operation: PlanOperationIdentity = { lifecycleGeneration: this.#planLifecycleGeneration, operationId: ++this.#nextPlanOperationId, sessionId, storeKey };
    Object.defineProperty(operation, "store", { enumerable: true, get: () => this.#operationStores.get(operation) });
    if (this.#currentStore && this.#currentStoreKey === storeKey) this.#operationStores.set(operation, this.#currentStore);
    this.#activePlanOperation = Object.freeze(operation); return operation;
  }
  planOperationMatchesContext(ctx: PlanContext, operation: PlanOperationIdentity): boolean {
    try { return operation.sessionId === ctx.sessionManager.getSessionId() && operation.storeKey === `${ctx.cwd}\0${ctx.sessionManager.getSessionId()}`; } catch { return false; }
  }
  isCurrentPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, requireStore = true): boolean {
    return this.#activePlanOperation === operation && this.#planLifecycleGeneration === operation.lifecycleGeneration && this.planOperationMatchesContext(ctx, operation) && (!requireStore || (operation.store !== undefined && operation.store === this.#currentStore && operation.storeKey === this.#currentStoreKey));
  }
  bindPlanOperation(ctx: PlanContext, operation: PlanOperationIdentity, store: PlanStore): boolean {
    if (!this.isCurrentPlanOperation(ctx, operation, false)) return false;
    this.#operationStores.set(operation, store); return this.isCurrentPlanOperation(ctx, operation);
  }
  resetRuntimeState(): void {
    this.fenceArtifactReads();
    this.#planLifecycleGeneration++; this.#activePlanOperation = undefined; this.#activePlanHandoffRequest = undefined;
    this.#mode = "act"; this.releaseFailedStore(); this.clearPlan();
    this.#pendingPlanExitReminder = undefined; this.#pendingPlanEnterNote = undefined;
    this.#pendingPlanCompactHandoff = undefined; this.#activePlanCompactHandoff = undefined;
    if (this.#planCompactionSettlementTimer) clearImmediate(this.#planCompactionSettlementTimer);
    this.#planCompactionSettlementTimer = undefined;
    this.#pendingCleanContextCompaction = undefined; this.#planContextReplacement = undefined;
  }
  resetRefinement(revision = -1): void { this.#refineSession = undefined; this.#refineSessionRevision = revision; this.discardRefineOutput(); }
  acceptRefinement(outcome: RefinePanelResult, revision: number, label: string | undefined): void {
    this.#refineSession = structuredClone(outcome.session); this.#refineSessionRevision = revision;
    this.#refineLatestOutput = outcome.latestOutput; this.#refineLatestRole = outcome.latestRole;
    this.#refineLatestAppliesAs = outcome.latestAppliesAs; this.#refineLatestRoleLabel = label;
  }
  discardRefineOutput(): void { this.#refineLatestOutput = undefined; this.#refineLatestRole = undefined; this.#refineLatestAppliesAs = undefined; this.#refineLatestRoleLabel = undefined; }
  activateApprovedMaterial(markdown: string): void { this.#latestPlan = markdown; this.#latestStatus = "approved"; }
  beginPlanHandoff(): PlanHandoffRequestIdentity {
    const request = Object.freeze({ lifecycleGeneration: this.#planLifecycleGeneration, requestId: ++this.#nextPlanHandoffRequestId });
    this.#activePlanHandoffRequest = request; return request;
  }
  isCurrentPlanHandoff(request: PlanHandoffRequestIdentity): boolean { return request.lifecycleGeneration === this.#planLifecycleGeneration && request.requestId === this.#activePlanHandoffRequest?.requestId && request.lifecycleGeneration === this.#activePlanHandoffRequest.lifecycleGeneration; }
  finishPlanHandoff(request: PlanHandoffRequestIdentity): boolean {
    if (!this.isCurrentPlanHandoff(request)) return false;
    this.#activePlanHandoffRequest = undefined;
    const matches = (value: PlanHandoffRequestIdentity | undefined) => value?.requestId === request.requestId && value.lifecycleGeneration === request.lifecycleGeneration;
    if (matches(this.#pendingPlanCompactHandoff?.request)) this.#pendingPlanCompactHandoff = undefined;
    if (matches(this.#activePlanCompactHandoff?.request)) this.#activePlanCompactHandoff = undefined;
    if (matches(this.#pendingCleanContextCompaction)) this.#pendingCleanContextCompaction = undefined;
    return true;
  }
  #trackHandoff(handoff: PlanCompactHandoff): PlanCompactHandoff {
    if (!this.#handoffWaiting.has(handoff)) {
      this.#handoffWaiting.set(handoff, handoff.waitingForCompactionSettlement === true);
      Object.defineProperty(handoff, "waitingForCompactionSettlement", { enumerable: true, get: () => this.#handoffWaiting.get(handoff) });
      Object.freeze(handoff);
    }
    return handoff;
  }
  queueCompactHandoff(handoff: PlanCompactHandoff): void { this.#pendingPlanCompactHandoff = this.#trackHandoff(handoff); }
  activateCompactHandoff(handoff: PlanCompactHandoff): void { this.#activePlanCompactHandoff = this.#trackHandoff(handoff); }
  releasePendingHandoff(): void { this.#pendingPlanCompactHandoff = undefined; }
  releaseActiveHandoff(): void { this.#activePlanCompactHandoff = undefined; }
  waitForCompaction(handoff: PlanCompactHandoff): void { this.#trackHandoff(handoff); this.#handoffWaiting.set(handoff, true); }
  observeCompactionSettled(handoff: PlanCompactHandoff): void { this.#trackHandoff(handoff); this.#handoffWaiting.set(handoff, false); }
  scheduleCompactionSettlement(callback: () => void): void {
    if (this.#planCompactionSettlementTimer) return;
    this.#planCompactionSettlementTimer = setImmediate(() => { this.#planCompactionSettlementTimer = undefined; callback(); });
    this.#planCompactionSettlementTimer.unref?.();
  }
  clearContextReplacement(): void { this.#planContextReplacement = undefined; }
  captureContextBaseline(messages: string[]): void { if (this.#planContextReplacement) this.#planContextReplacement.baselineMessages = [...messages]; }
  replaceContext(replacement: AgentMessage): void { this.#planContextReplacement = { lifecycleGeneration: this.#planLifecycleGeneration, replacement: structuredClone(replacement) }; }
  consumeCleanContext(): PlanCleanContextCompactionRequest | undefined { const request = this.#pendingCleanContextCompaction; this.#pendingCleanContextCompaction = undefined; return request && this.isCurrentPlanHandoff(request) ? structuredClone(request) : undefined; }
}
