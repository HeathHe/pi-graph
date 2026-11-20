import { createHash } from "node:crypto";
import { realpathSync, readFileSync } from "node:fs";
import type { BudgetHistory, BudgetPoolScope } from "pi-graph-permission-core";
import type { ActiveGoal, GoalContext } from "./types.ts";

export type GoalBudgetContext = Pick<GoalContext, "cwd" | "sessionManager">;
interface JournalEntry { id?: string; parentId?: string | null; type?: string; customType?: string; data?: unknown; }
interface JournalManager { getSessionId?(): string; getBranch?(): readonly JournalEntry[]; getLeafId?(): string | null; getSessionFile?(): string | undefined; }
export interface GoalBudgetJournalPin { readonly entryId: string; readonly digest: string; }
export interface GoalBudgetCoveragePort {
  epoch?(): string;
  birth(goalId: string, pin: GoalBudgetJournalPin, assertSource: () => void): object | undefined;
  snapshot?(proof: object, pin: GoalBudgetJournalPin): { hostEpoch: string; initialized: boolean };
  adopt?(pin: GoalBudgetJournalPin, assertSource: () => void, initialized: boolean): object;
  assert(proof: object, pin: GoalBudgetJournalPin): void;
  initialize(proof: object, pin: GoalBudgetJournalPin): BudgetHistory;
}
declare const goalBudgetScope: unique symbol;
export interface GoalBudgetScope { readonly [goalBudgetScope]: true; }
export type GoalBudgetSource = { readonly kind: "none" } | { readonly kind: "declared"; readonly scope: GoalBudgetScope };
export interface GoalBudgetDeclaration {
  readonly poolScope: BudgetPoolScope;
  readonly limit: number;
  readonly goalEntry: GoalBudgetJournalPin;
  readonly birth?: GoalBudgetJournalPin;
  readonly historyCut: GoalBudgetJournalPin;
  readonly history: BudgetHistory;
}
export interface GoalCoverageAdoption { readonly poolScope: BudgetPoolScope; readonly birth: GoalBudgetJournalPin; readonly initialized: boolean; }
export interface GoalCoverageCloseFact extends GoalCoverageAdoption { readonly scope: GoalBudgetScope; readonly hostEpoch: string; readonly coverageVersion: 1; }
export interface GoalBudgetSourcePort {
  capture(goalId: string, ctx: GoalBudgetContext): GoalBudgetSource;
  captureSelected?(ctx: GoalBudgetContext): GoalBudgetSource;
  assertNone?(source: GoalBudgetSource): void;
  read(scope: GoalBudgetScope, phase: "send" | "fact" | "configuration"): GoalBudgetDeclaration;
  assertCoverage?(scope: GoalBudgetScope): void;
  subscribe?(scope: GoalBudgetScope, invalidated: () => void): () => void;
  initialHistory?(scope: GoalBudgetScope): BudgetHistory;
  coverageInfo?(scope: GoalBudgetScope): { required: boolean; birth?: GoalBudgetJournalPin; hostEpoch?: string; initialized?: boolean };
  captureCoverageClose?(ctx: GoalBudgetContext): readonly GoalCoverageCloseFact[];
  adoptCoverage?(ctx: GoalBudgetContext, verified: object): void;
  restoredCoverage?(ctx: GoalBudgetContext): readonly { scope: GoalBudgetScope; poolScope: BudgetPoolScope; hostEpoch: string }[];
}
interface SourcePorts {
  goal(id: string): ActiveGoal | undefined;
  goals?(): readonly ActiveGoal[];
  selected?(): ActiveGoal | undefined;
  capture(ctx: GoalBudgetContext): object;
  captureContinuity?(ctx: GoalBudgetContext): { assertCurrent(): void };
  assert(scope: object): void;
  subscribe?(scope: object, changed: () => void): () => void;
  coverage?(ctx: GoalBudgetContext): GoalBudgetCoveragePort | undefined;
  coverageRequired?(ctx: GoalBudgetContext): boolean;
  readAdoption?(grant: object, ctx: GoalBudgetContext): GoalCoverageAdoption;
}
interface Grant {
  readonly lease: object;
  readonly ctx: GoalBudgetContext;
  readonly declaration: GoalBudgetDeclaration;
}
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const STATE = "pi-graph-next:goal-state";

function declaredGoal(entry: JournalEntry, goalId: string): Partial<ActiveGoal> | undefined {
  if (entry.type !== "custom" || entry.customType !== STATE || !entry.data || typeof entry.data !== "object") return;
  const data = entry.data as { goals?: unknown; goal?: unknown };
  const goals = Array.isArray(data.goals) ? data.goals : [data.goal];
  return goals.find((value): value is Partial<ActiveGoal> => Boolean(value && typeof value === "object" && value.id === goalId));
}
function budgetDeclaration(entries: readonly JournalEntry[], goalId: string): JournalEntry | undefined {
  let previous: number | undefined;
  let declaration: JournalEntry | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== STATE) continue;
    const value = declaredGoal(entry, goalId)?.tokenBudget;
    if (value !== previous) declaration = value === undefined ? undefined : entry;
    previous = value;
  }
  return declaration;
}
function pin(entry: JournalEntry): GoalBudgetJournalPin {
  if (!entry.id) throw new Error("Goal budget requires an original journal entry id");
  return { entryId: entry.id, digest: digest(entry) };
}
function branch(ctx: GoalBudgetContext): readonly JournalEntry[] {
  const manager = ctx.sessionManager as JournalManager | undefined;
  const entries = manager?.getBranch?.();
  if (!Array.isArray(entries) || entries.some(entry => !entry.id)) throw new Error("Goal budget journal unavailable");
  if (!entries.length || (manager?.getLeafId?.() ?? entries.at(-1)?.id) !== entries.at(-1)?.id) throw new Error("Goal budget journal leaf changed");
  return entries;
}
export function validateGoalBudget(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) {
    throw new Error("Goal token budget must be a nonnegative safe integer");
  }
}

/** The original Goal owner supplies these closures. No journal DTO can issue a scope. */
export function createGoalBudgetSource(ports: SourcePorts): GoalBudgetSourcePort & {
  created(goal: ActiveGoal): void;
  published(goals: readonly ActiveGoal[], ctx: GoalContext | undefined): void;
} {
  const issued = new WeakMap<object, Grant>();
  const observers = new Set<() => void>();
  type Identity = Pick<JournalEntry, "id" | "parentId" | "type" | "customType">;
  const identity = (entry: JournalEntry): Identity => ({ id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType });
  const negatives = new WeakMap<object, { lease: object; ctx: GoalBudgetContext; target?: string; revision: string; cut: readonly Identity[] }>();
  const negativePin = (ctx: GoalBudgetContext, target?: string) => {
    const manager = ctx.sessionManager as JournalManager | undefined, entries = manager?.getBranch?.();
    if (!Array.isArray(entries) || entries.some(entry => !entry.id)
      || (manager?.getLeafId?.() ?? entries.at(-1)?.id ?? null) !== (entries.at(-1)?.id ?? null)) throw new Error("Goal negative source journal unavailable");
    const signature = (goal: Partial<ActiveGoal> | undefined) => digest(goal ? { id: goal.id, ...(!target ? { status: goal.status } : {}), tokenBudget: goal.tokenBudget } : null);
    let previous = signature(undefined), revision = "original-empty-goal-selection";
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== STATE) continue;
      const data = entry.data as { currentGoalId?: string; goal?: Partial<ActiveGoal> | null; goals?: Partial<ActiveGoal>[] } | undefined;
      const id = target ?? data?.currentGoalId ?? data?.goal?.id;
      const selected = id ? (data?.goals?.find(goal => goal.id === id) ?? (data?.goal?.id === id ? data.goal : undefined)) : undefined;
      const next = signature(selected);
      if (next !== previous) { revision = entry.id!; previous = next; }
    }
    if (previous !== signature(target ? ports.goal(target) : ports.selected?.())) throw new Error("Goal negative source differs from its original journal");
    return { revision, entries };
  };
  const issueNone = (ctx: GoalBudgetContext, lease: object, target?: string): GoalBudgetSource => {
    const pin = negativePin(ctx, target), none: GoalBudgetSource = { kind: "none" };
    ports.assert(lease);
    negatives.set(none, { lease, ctx, target, revision: pin.revision, cut: pin.entries.map(identity) }); return none;
  };
  const created = new WeakSet<ActiveGoal>();
  const births = new Map<string, GoalBudgetJournalPin>();
  const coverage = new Map<string, { proof: object; port: GoalBudgetCoveragePort; birth: GoalBudgetJournalPin }>();
  return {
    created(goal) { if (goal.tokenBudget !== undefined) created.add(goal); },
    published(goals, ctx) {
      if (!ctx) return;
      for (const id of coverage.keys()) if (!goals.some(goal => goal.id === id)) coverage.delete(id);
      for (const goal of goals) {
        if (!created.delete(goal)) continue;
        // This pin is a creation fact only. It does not attest request coverage.
        try {
          const lease = ports.capture(ctx);
          const entry = branch(ctx).at(-1)!;
          if (declaredGoal(entry, goal.id)?.tokenBudget === goal.tokenBudget) {
            const birth = pin(entry); births.set(goal.id, birth);
            ports.assert(lease);
            const continuity = ports.captureContinuity?.(ctx), port = ports.coverage?.(ctx);
            const proof = port?.birth(goal.id, birth, () => continuity ? continuity.assertCurrent() : ports.assert(lease));
            if (port && proof) coverage.set(goal.id, { proof, port, birth });
          }
          ports.assert(lease);
        } catch { births.delete(goal.id); coverage.delete(goal.id); }
      }
      for (const check of [...observers]) { try { check(); } catch { /* Read-only observers cannot invalidate a committed publication. */ } }
    },
    subscribe(scope, invalidated) {
      const grant = issued.get(scope); if (!grant) throw Error("Unissued Goal budget scope");
      const check = () => { invalidated(); }; // Notification only; each original caller rechecks its own source. 
      this.read(scope, "send"); observers.add(check);
      let dispose: (() => void) | undefined;
      try { dispose = ports.subscribe?.(grant.lease, check); }
      catch (error) { observers.delete(check); throw error; }
      return () => { observers.delete(check); dispose?.(); };
    },
    captureSelected(ctx) {
      const lease = ports.capture(ctx);
      const goal = ports.selected?.();
      ports.assert(lease);
      if (goal?.status === "active" && goal.tokenBudget !== undefined) return this.capture(goal.id, ctx);
      return issueNone(ctx, lease);
    },
    assertNone(source) {
      const grant = negatives.get(source);
      if (!grant || source.kind !== "none") throw new Error("Unissued Goal negative source");
      ports.assert(grant.lease);
      const pin = negativePin(grant.ctx, grant.target);
      if (pin.revision !== grant.revision || grant.cut.some((original, index) => {
        const entry = pin.entries[index];
        return !entry || original.id !== entry.id || original.parentId !== entry.parentId || original.type !== entry.type || original.customType !== entry.customType;
      })) throw new Error("Goal negative source changed; old child cannot adopt a new selection");
      const selected = grant.target ? ports.goal(grant.target) : ports.selected?.();
      if (selected?.tokenBudget !== undefined && (grant.target || selected.status === "active")) throw new Error("Goal negative source now has a declared budget");
      ports.assert(grant.lease);
    },
    capture(goalId, ctx) {
      const goal = ports.goal(goalId);
      if (!goal) throw new Error("Goal budget parent is unavailable");
      validateGoalBudget(goal.tokenBudget);
      const lease = ports.capture(ctx);
      const entries = branch(ctx);
      const latest = entries.filter(entry => entry.type === "custom" && entry.customType === STATE).at(-1);
      const published = latest && declaredGoal(latest, goalId);
      if (!latest || !published || published.tokenBudget !== goal.tokenBudget) throw new Error("Goal budget declaration differs from its original journal");
      if (goal.tokenBudget === undefined) return issueNone(ctx, lease, goalId);
      const manager = ctx.sessionManager as JournalManager;
      const sessionId = manager.getSessionId?.();
      const data = latest.data as { sessionId?: unknown };
      if (!sessionId || data.sessionId !== sessionId) throw new Error("Goal budget durable session differs from its journal");
      const remembered = births.get(goalId);
      const birth = remembered && entries.find(entry => entry.id === remembered.entryId && digest(entry) === remembered.digest) ? remembered : undefined;
      const budgetEntry = budgetDeclaration(entries, goalId);
      if (!budgetEntry) throw new Error("Goal budget declaration entry unavailable");
      const declaration: GoalBudgetDeclaration = {
        poolScope: { workspace: realpathSync(ctx.cwd), sessionId, goalId },
        limit: goal.tokenBudget,
        goalEntry: pin(budgetEntry),
        ...(birth ? { birth } : {}),
        historyCut: { entryId: entries.at(-1)!.id!, digest: digest(entries.map(entry => ({ id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType }))) },
        history: { kind: "unknown", debits: [] },
      };
      ports.assert(lease);
      const scope = Object.freeze({}) as GoalBudgetScope;
      issued.set(scope, { lease, ctx, declaration });
      return { kind: "declared", scope };
    },
    restoredCoverage(ctx) {
      const lease = ports.capture(ctx); ports.assert(lease);
      const hostEpoch = ports.coverage?.(ctx)?.epoch?.(); if (!hostEpoch) return [];
      const all = new Map((ports.goals?.() ?? []).map(goal => [goal.id, goal]));
      const selected = ports.selected?.(); if (selected) all.set(selected.id, selected);
      const result: { scope: GoalBudgetScope; poolScope: BudgetPoolScope; hostEpoch: string }[] = [];
      for (const goal of all.values()) {
        if (goal.tokenBudget === undefined) continue;
        try {
          const source = this.capture(goal.id, ctx); if (source.kind !== "declared") continue;
          result.push({ scope: source.scope, poolScope: this.read(source.scope, "fact").poolScope, hostEpoch });
        } catch { /* Invalid historical declarations remain readable, but never gain coverage. */ }
      }
      ports.assert(lease); return result;
    },
    coverageInfo(scope) {
      const grant = issued.get(scope); if (!grant) throw new Error("Unissued Goal coverage scope");
      ports.assert(grant.lease);
      const required = ports.coverageRequired?.(grant.ctx) !== false;
      if (!required) return { required: false };
      this.assertCoverage!(scope);
      const record = coverage.get(grant.declaration.poolScope.goalId)!;
      const snapshot = record.port.snapshot?.(record.proof, record.birth);
      if (!snapshot) throw new Error("Goal coverage epoch identity unavailable");
      return { required: true, birth: { ...record.birth }, hostEpoch: snapshot.hostEpoch, initialized: snapshot.initialized };
    },
    captureCoverageClose(ctx) {
      const lease = ports.capture(ctx); ports.assert(lease); const result: GoalCoverageCloseFact[] = [];
      for (const [goalId, record] of coverage) {
        const goal = ports.goal(goalId); if (!goal || goal.tokenBudget === undefined) continue;
        try {
          const source = this.capture(goalId, ctx); if (source.kind !== "declared") continue;
          this.assertCoverage!(source.scope);
          const snapshot = record.port.snapshot?.(record.proof, record.birth);
          if (!snapshot) continue;
          result.push({ scope: source.scope, poolScope: this.read(source.scope, "fact").poolScope,
            birth: { ...record.birth }, initialized: snapshot.initialized, hostEpoch: snapshot.hostEpoch, coverageVersion: 1 });
        } catch { /* One historical/unknown Goal cannot borrow or poison another Goal's valid birth. */ }
      }
      ports.assert(lease); return result;
    },
    adoptCoverage(ctx, verified) {
      const lease = ports.capture(ctx); ports.assert(lease);
      const adopted = ports.readAdoption?.(verified, ctx);
      if (!adopted) throw new Error("Unissued native coverage adoption");
      const manager = ctx.sessionManager as JournalManager, entries = branch(ctx), goal = ports.goal(adopted.poolScope.goalId);
      const original = entries.find(entry => entry.id === adopted.birth.entryId);
      if (!goal || goal.tokenBudget === undefined || adopted.poolScope.workspace !== realpathSync(ctx.cwd)
        || adopted.poolScope.sessionId !== manager.getSessionId?.() || !original || digest(original) !== adopted.birth.digest
        || declaredGoal(original, goal.id)?.tokenBudget === undefined) throw new Error("Coverage adoption does not match the original Goal birth/source");
      const continuity = ports.captureContinuity?.(ctx), port = ports.coverage?.(ctx);
      if (!continuity || !port?.adopt) throw new Error("Fresh Goal coverage adoption host unavailable");
      const proof = port.adopt(adopted.birth, () => continuity.assertCurrent(), adopted.initialized);
      births.set(goal.id, { ...adopted.birth }); coverage.set(goal.id, { proof, port, birth: { ...adopted.birth } });
      ports.assert(lease);
    },
    assertCoverage(scope) {
      const grant = issued.get(scope), record = grant && coverage.get(grant.declaration.poolScope.goalId);
      // Unregistered direct owner fixtures retain their old seeded-pool path.
      // Every real extension session registers explicitly before source load.
      if (grant && !record && ports.coverageRequired?.(grant.ctx) === false) { ports.assert(grant.lease); return; }
      if (!grant || !record || !grant.declaration.birth || grant.declaration.birth.entryId !== record.birth.entryId
        || grant.declaration.birth.digest !== record.birth.digest) throw new Error("Goal history lacks continuous request coverage from its original birth");
      ports.assert(grant.lease); record.port.assert(record.proof, record.birth);
    },
    initialHistory(scope) {
      this.assertCoverage!(scope); const grant = issued.get(scope)!, record = coverage.get(grant.declaration.poolScope.goalId);
      if (!record) throw new Error("Goal historical usage is unknown; no original continuous-birth proof");
      const file = (grant.ctx.sessionManager as JournalManager).getSessionFile?.();
      let durable: unknown;
      try { durable = file && readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line) as JournalEntry).find(entry => entry.id === record.birth.entryId); }
      catch { /* The setup-only SDK journal has no durable receipt capability. */ }
      if (!durable || digest(durable) !== record.birth.digest) throw new Error("Goal birth is not in a reliable persistent journal; no budget request was sent");
      return record.port.initialize(record.proof, record.birth);
    },
    read(scope, phase) {
      const grant = issued.get(scope);
      if (!grant) throw new Error("Goal budget scope was not issued by the loaded Goal owner");
      ports.assert(grant.lease);
      const entries = branch(grant.ctx);
      const declaration = grant.declaration;
      const original = entries.find(entry => entry.id === declaration.goalEntry.entryId);
      const cut = entries.findIndex(entry => entry.id === declaration.historyCut.entryId);
      if (!original || digest(original) !== declaration.goalEntry.digest || cut < 0
        || digest(entries.slice(0, cut + 1).map(entry => ({ id: entry.id, parentId: entry.parentId, type: entry.type, customType: entry.customType }))) !== declaration.historyCut.digest) {
        throw new Error("Goal budget original journal pin changed");
      }
      if (phase !== "fact") {
        const current = ports.goal(declaration.poolScope.goalId);
        const latest = entries.filter(entry => entry.type === "custom" && entry.customType === STATE).at(-1);
        if (!current || (phase === "send" && current.status !== "active") || current.tokenBudget !== declaration.limit
          || declaredGoal(latest!, current.id)?.tokenBudget !== declaration.limit
          || budgetDeclaration(entries, current.id)?.id !== declaration.goalEntry.entryId) {
          throw new Error("Goal budget declaration changed; capture a current scope");
        }
      }
      ports.assert(grant.lease);
      return structuredClone(declaration);
    },
  };
}
