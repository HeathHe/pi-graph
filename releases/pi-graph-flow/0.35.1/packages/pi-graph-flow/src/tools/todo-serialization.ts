import { realpathSync } from "node:fs";
import { TASK_CLEAR_EVIDENCE_TYPE, validateTaskClearEvidence, type TaskClearEvidence, type LoadedTaskClearEvidence, type TaskClearEvidencePin, assertClearSnapshot, taskIsCleared, validateClearRecord, validateClearHistory, type TaskClearRecord } from "../task-workflow/task-clear.ts";
import { validateReplacementGroups } from "../task-workflow/plan-replacement.ts";
import { initializeTaskContract } from "../task-workflow/acceptance.ts";
import { readDeliveryGroups, type DeliveryGroup } from "../task-workflow/delivery-group.ts";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
let goalExists: ((id: string) => unknown) | undefined;
export function configureTodoGoalReader(reader: (id: string) => unknown): void { goalExists = reader; }
import type { TodoSkillConfig } from "../skills/skill-loader.ts";
import type { TodoSkillBinding } from "../skills/skill-composer.ts";
import type {
  SkillActivationBindingMetadata,
  SkillActivationMetadata,
} from "../skills/skill-runtime.ts";
import type { TodoTaskOrigin } from "../session/types.ts";
import type {
  TaskStatus,
  TodoActorRef,
  TodoContext,
  TodoParams,
  TodoTask,
} from "../task-workflow/types.ts";
import {
  isSkillRole,
  normalizeSkillBinding,
  normalizeSkillConfig,
} from "./todo-skill-engine.ts";
import { readTodoHandoff, readTodoResourceUris } from "./todo-contract.ts";

export { isSkillRole };

export const TODO_STATE_ENTRY_TYPE = "pi-graph-next:todo-state";
export const TODO_CONTENT_ENTRY_TYPE = "pi-graph-next:todo-content";
export const TODO_STATE_VERSION = 10;
const TODO_CONTENT_VERSION = 1;

export interface TodoSerializationContext {
  getExtensionApi: () => ExtensionAPI | undefined;
  getTasks: () => Map<string, TodoTask>;
  getTodoGeneration: () => number;
  appendEntry?: (type: string, data: unknown) => void;
  rootActor: TodoActorRef;
  getDeliveryGroups?: () => readonly DeliveryGroup[];
  getTaskClearHistory?: () => readonly TaskClearRecord[];
  getCanonicalEntries?: () => readonly TodoContentEntry[];
}

let serializationContext: TodoSerializationContext | undefined;
interface TodoContentEntry {id?: string; type?: string; customType?: string; data?: unknown;}
let replacementAllocatorHighWater: number | undefined;
let loadedTaskClearHistory: TaskClearRecord[] = [];
export function getLoadedTaskClearHistory(): TaskClearRecord[] { return structuredClone(loadedTaskClearHistory); }
export function getReplacementAllocatorHighWater(): number { return replacementAllocatorHighWater ?? 0; }
let persistedTodoContentRefs = new Set<string>();
let persistedContentEntries = new Map<string, string>();

export function configureTodoSerialization(context: TodoSerializationContext): void {
  serializationContext = context;
}

function requireSerializationContext(): TodoSerializationContext {
  if (!serializationContext) throw new Error("todo serialization context is not initialized");
  return serializationContext;
}

function todoContent(task: TodoTask): Record<string, unknown> | undefined {
  const content: Record<string, unknown> = {};
  if (task.description !== undefined) content.description = task.description;
  if (task.context !== undefined) content.context = task.context;
  if (task.resourceUris.length > 0) content.resourceUris = [...task.resourceUris];
  if (task.handoff !== undefined) content.handoff = task.handoff;
  if (task.skillActivation !== undefined) content.skillActivation = task.skillActivation;
  if (task.summary !== undefined) content.summary = task.summary;
  return Object.keys(content).length > 0 ? content : undefined;
}

function todoContentRef(content: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function todoStateTask(task: TodoTask, contentRef?: string): Record<string, unknown> {
  return {
    ...Object.fromEntries(["reviewRequired", "dispatchSubmissionId", "taskInstanceId", "contractVersion", "contractDigest", "contractDependencies", "acceptanceCriteria", "acceptanceReport", "verifiedQualityGateId", "deliveryGoalId", "deliveryGroupId", "skipResolution", "replacementPendingId", "supersededByGroupId", "supersessionId"].filter(key => task[key as keyof TodoTask] !== undefined).map(key => [key, task[key as keyof TodoTask]])),
    id: task.id,
    subject: task.subject,
    status: task.status,
    blockedBy: [...task.blockedBy],
    skills: task.skills.map((skill) => ({ ...skill })),
    ...(task.origin !== undefined ? { origin: task.origin } : {}),
    ...(task.planHandoffKey !== undefined ? { planHandoffKey: task.planHandoffKey } : {}),
    ...(task.goalId !== undefined ? { goalId: task.goalId } : {}),
    createdBy: { ...task.createdBy },
    assignee: { ...task.assignee },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.activeStartedAt !== undefined ? { activeStartedAt: task.activeStartedAt } : {}),
    ...(task.activeDurationMs !== undefined ? { activeDurationMs: task.activeDurationMs } : {}),
    ...(task.completedAt !== undefined ? { completedAt: task.completedAt } : {}),
    ...(contentRef !== undefined ? { contentRef } : {}),
  };
}

/** One pure encoding shared by ordinary persistence and native-journal witnesses. */
export interface TodoPublication {
  contents: Record<string, Record<string, unknown>>;
  state: { version: number; tasks: Record<string, Record<string, unknown>>; deliveryGroups?: readonly DeliveryGroup[]; replacementAllocatorHighWater?: number; taskClearHistory?: readonly TaskClearRecord[] };
}
function encodeTodoPublication(state: Map<string, TodoTask>, groups: readonly DeliveryGroup[] = [], clears: readonly TaskClearRecord[] = requireSerializationContext().getTaskClearHistory?.() ?? []): TodoPublication {
  const contents: Record<string, Record<string, unknown>> = {};
  const stateTasks: Record<string, Record<string, unknown>> = {};
  for (const [id, task] of state) {
    const content = todoContent(task);
    const contentRef = content === undefined ? undefined : todoContentRef(content);
    if (content !== undefined && contentRef !== undefined) contents[contentRef] = content;
    stateTasks[id] = todoStateTask(task, contentRef);
  }
  const receipts = groups.flatMap(group => group.replacementHistory ?? []);
  const highWater = replacementAllocatorHighWater !== undefined || receipts.length || clears.length
    ? Math.max(replacementAllocatorHighWater ?? 0, 0, ...[...state.keys()].map(id => /^\d+$/.test(id) ? Number(id) : 0), ...receipts.map(receipt => receipt.allocatorHighWater), ...clears.map(receipt => receipt.allocatorHighWater)) : undefined;
  return {contents, state: {version: TODO_STATE_VERSION, tasks: stateTasks, ...(groups.length ? {deliveryGroups: groups} : {}), ...(highWater !== undefined ? {replacementAllocatorHighWater: highWater} : {}), ...(clears.length ? {taskClearHistory: clears} : {})}};
}
function hasUnpublishedTodoContents(publication: TodoPublication): boolean {
  return Object.keys(publication.contents).some(ref => !persistedTodoContentRefs.has(ref));
}
/** Same envelope including groups/content references, excluding only generated timestamps. */
function todoPublicationSemanticDigest(publication: TodoPublication): string {
  const state = structuredClone(publication.state);
  for (const task of Object.values(state.tasks)) delete task.updatedAt;
  return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
function publishTodoPublication(publication: TodoPublication): void {
  const api = requireSerializationContext().getExtensionApi();
  const append = requireSerializationContext().appendEntry ?? api?.appendEntry.bind(api);
  if (!append) throw new Error("Todo persistence unavailable.");
  const newContents = Object.fromEntries(Object.entries(publication.contents).filter(([ref]) => !persistedTodoContentRefs.has(ref)));
  const refs = Object.keys(newContents);
  if (refs.length) {
    const previousIds = new Set(requireSerializationContext().getCanonicalEntries?.().map(entry => entry.id));
    append(TODO_CONTENT_ENTRY_TYPE, {version: TODO_CONTENT_VERSION, contents: newContents});
    for (const entry of requireSerializationContext().getCanonicalEntries?.() ?? []) {
      if (!entry.id || previousIds.has(entry.id) || entry.type !== "custom" || entry.customType !== TODO_CONTENT_ENTRY_TYPE) continue;
      const contents = asRecord(asRecord(entry.data)?.contents);
      for (const ref of refs) { const content = asRecord(contents?.[ref]); if (content && todoContentRef(content) === ref) persistedContentEntries.set(ref, entry.id); }
    }
    for (const ref of refs) persistedTodoContentRefs.add(ref);
  }
  const statePin = createHash("sha256").update(JSON.stringify(publication.state)).digest("hex");
  append(TODO_STATE_ENTRY_TYPE, publication.state);
  if (publication.state.replacementAllocatorHighWater !== undefined) replacementAllocatorHighWater = publication.state.replacementAllocatorHighWater;
  if (createHash("sha256").update(JSON.stringify(publication.state)).digest("hex") !== statePin) throw new Error("Task publication envelope changed during append");
}
export interface PreparedTodoPublication {
  publication: TodoPublication;
  semanticDigest: string;
  hasNewContents: boolean;
  assertExistingContents(): void;
}
export interface TodoPersist {
  (state?: Map<string, TodoTask>, groups?: readonly DeliveryGroup[], clears?: readonly TaskClearRecord[]): void;
  prepare?: (state: Map<string, TodoTask>, groups?: readonly DeliveryGroup[], clears?: readonly TaskClearRecord[]) => PreparedTodoPublication;
}
export const persist: TodoPersist = function persist(
  state = requireSerializationContext().getTasks(),
  groups = requireSerializationContext().getDeliveryGroups?.() ?? [],
  clears = requireSerializationContext().getTaskClearHistory?.() ?? [],
): void { publishTodoPublication(encodeTodoPublication(state, groups, clears)); };
persist.prepare = (state, groups = [], clears = requireSerializationContext().getTaskClearHistory?.() ?? []) => {
  const publication = encodeTodoPublication(state, groups, clears);
  const pins = Object.keys(publication.contents).map(ref => ({ref, id: persistedContentEntries.get(ref)}));
  return {publication, semanticDigest: todoPublicationSemanticDigest(publication), hasNewContents: hasUnpublishedTodoContents(publication),
    assertExistingContents() {
      const entries = requireSerializationContext().getCanonicalEntries?.() ?? [];
      for (const {ref, id} of pins) {
        const matches = id === undefined ? [] : entries.filter(entry => entry.id === id && entry.type === "custom" && entry.customType === TODO_CONTENT_ENTRY_TYPE);
        if (matches.length !== 1) throw new Error("Native journal canonical content entry changed");
        const content = asRecord(asRecord(asRecord(matches[0]!.data)?.contents)?.[ref]);
        if (!content || todoContentRef(content) !== ref) throw new Error("Native journal canonical content changed");
      }
    }};
};

let loadedTaskClearEvidence: LoadedTaskClearEvidence = {pins:[]};
let evidenceAppendExpected: TaskClearEvidence | undefined;
export function getLoadedTaskClearEvidence(): LoadedTaskClearEvidence { return structuredClone(loadedTaskClearEvidence); }
function clearDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex"); }
function clearEvidencePins(entries: readonly TodoContentEntry[]): TaskClearEvidencePin[] {
  const ids=new Set<string>();
  return entries.filter(e=>e.type==="custom"&&e.customType===TASK_CLEAR_EVIDENCE_TYPE).map(e=>{
    if(!e.id||ids.has(e.id))throw new Error("Task clear evidence identity missing or duplicated");ids.add(e.id);
    return {entryId:e.id,digest:clearDigest(e.data)};
  });
}
/** Recheck the previously observed authority, including inside append callbacks. */
export function assertTaskClearEvidenceCurrent(): void {
  const entries=requireSerializationContext().getCanonicalEntries?.()??[];
  const actual=clearEvidencePins(entries),expected=loadedTaskClearEvidence.pins;
  if(actual.length<expected.length || actual.slice(0,expected.length).some((pin,i)=>clearDigest(pin)!==clearDigest(expected[i])))throw new Error("Task clear evidence authority changed");
  if(actual.length!==expected.length) {
    if(!evidenceAppendExpected || actual.length!==expected.length+1 || actual.at(-1)!.digest!==clearDigest(evidenceAppendExpected))throw new Error("Unexpected Task clear evidence publication");
  }
  // Recheck only explicitly clear-owned publications; latest-state leases do not pin these old bodies.
  if(actual.length)readClearJournalContinuity(entries);
}
/** Reads a specifically referenced clear-owned Task publication, never arbitrary old Task bodies. */
function clearPublicationAt(entries:readonly TodoContentEntry[],entry:TodoContentEntry):TodoPublication {
  const data=asRecord(entry.data),raw=asRecord(data?.tasks);
  if(!data||!raw)throw new Error("Invalid Task clear state envelope: tasks object is required");
  const contents:Record<string,Record<string,unknown>>={},refs:string[]=[];
  for(const task of Object.values(raw)) {
    const ref=asRecord(task)?.contentRef;if(ref===undefined)continue;
    if(typeof ref!=="string")throw new Error("Invalid Task clear content reference");
    if(!refs.includes(ref))refs.push(ref);
  }
  const found=new Map<string,Record<string,unknown>>();
  for(const candidate of entries) {
    if(candidate===entry)break;
    if(candidate.type!=="custom"||candidate.customType!==TODO_CONTENT_ENTRY_TYPE)continue;
    const envelope=asRecord(asRecord(candidate.data)?.contents);
    for(const ref of refs) {
      const content=asRecord(envelope?.[ref]);if(!content)continue;
      if(todoContentRef(content)!==ref)throw new Error("Task clear content changed");found.set(ref,content);
    }
  }
  for(const ref of refs){const content=found.get(ref);if(!content)throw new Error("Task clear content missing");contents[ref]=content;}
  return {contents,state:data as unknown as TodoPublication["state"]};
}
function readClearJournalContinuity(entries:readonly TodoContentEntry[]):LoadedTaskClearEvidence {
  const result:LoadedTaskClearEvidence={pins:clearEvidencePins(entries)};
  const taskEntries=entries.filter(e=>e.type==="custom"&&e.customType===TODO_STATE_ENTRY_TYPE),latest=taskEntries.at(-1);
  const rawHistory=asRecord(latest?.data)?.taskClearHistory;
  if(rawHistory!==undefined&&!Array.isArray(rawHistory))throw new Error("Invalid Task clear history envelope");
  const records=(rawHistory??[]) as TaskClearRecord[];
  const own=entries.filter(e=>e.type==="custom"&&e.customType===TASK_CLEAR_EVIDENCE_TYPE);
  let count=0;
  for(let i=0;i<own.length;i++) {
    const entry=own[i]!,intent=entry.data;validateTaskClearEvidence(intent);
    if(intent.phase!=="intent" || clearDigest(intent.previous??null)!==clearDigest(result.lastTerminal??null))throw new Error("Task clear intent chain changed");
    assertClearSnapshot(intent.record,entries,intent.record.source.workspace,intent.record.source.sessionId);
    const pin=result.pins[i]!;
    const index=entries.indexOf(entry);
    const reservation=entries.slice(index+1).find(e=>e.type==="custom"&&e.customType===TODO_STATE_ENTRY_TYPE);
    if(!reservation) {
      if(i!==own.length-1 || !latest || latest.id!==intent.record.snapshot.entryId || clearDigest(latest.data)!==intent.record.snapshot.stateDigest || records.length!==count)throw new Error("Task clear marker-only state changed");
      result.pending={intent,pin};break;
    }
    const reservationPin={entryId:reservation.id!,digest:clearDigest(clearPublicationAt(entries,reservation))};
    const reservedRecords=asRecord(reservation.data)?.taskClearHistory as TaskClearRecord[]|undefined;
    if(!reservation.id || reservationPin.digest!==intent.reservationDigest || !Array.isArray(reservedRecords) || reservedRecords.length!==count+1 || clearDigest(reservedRecords[count])!==clearDigest(intent.record))throw new Error("Task clear reservation publication changed");
    const terminalEntry=own[i+1];
    if(!terminalEntry) {
      if(latest!==reservation || records.length!==count+1 || clearDigest(records[count])!==clearDigest(intent.record))throw new Error("Task clear terminal evidence missing");
      result.pending={intent,pin,reservation:reservationPin};count++;break;
    }
    const terminal=terminalEntry.data;validateTaskClearEvidence(terminal);
    const complete={...structuredClone(intent.record),phase:"complete",...(intent.record.kind==="local"?{nativeWitnessId:terminal.record.nativeWitnessId}:{})};
    if(terminal.phase!=="terminal" || entries.indexOf(terminalEntry)<entries.indexOf(reservation) || clearDigest(terminal.intent)!==clearDigest(pin) || clearDigest(terminal.reservation)!==clearDigest(reservationPin) || clearDigest(terminal.record)!==clearDigest(complete))throw new Error("Task clear terminal identity changed");
    i++;result.lastTerminal=result.pins[i];
    const final=entries.slice(entries.indexOf(terminalEntry)+1).find(e=>e.type==="custom"&&e.customType===TODO_STATE_ENTRY_TYPE);
    if(!final) {
      if(i!==own.length-1 || latest!==reservation || records.length!==count+1)throw new Error("Task clear terminal-only state changed");
      result.pending={intent,pin,reservation:reservationPin,terminal};count++;break;
    }
    const finalPublication=clearPublicationAt(entries,final);
    if(clearDigest(finalPublication)!==terminal.publicationDigest || clearDigest(finalPublication.state.taskClearHistory?.[count])!==clearDigest(terminal.record) || clearDigest(records[count])!==clearDigest(terminal.record))throw new Error("Task clear final history changed");
    count++;
  }
  if(records.length!==count)throw new Error("Task clear history has no matching evidence");
  return result;
}
export function refreshTaskClearEvidence(): LoadedTaskClearEvidence {
  assertTaskClearEvidenceCurrent();
  const next=readClearJournalContinuity(requireSerializationContext().getCanonicalEntries?.()??[]);
  loadedTaskClearEvidence=next;return getLoadedTaskClearEvidence();
}
export function appendTaskClearEvidence(evidence:TaskClearEvidence):void {
  assertTaskClearEvidenceCurrent();validateTaskClearEvidence(evidence);
  const copy=structuredClone(evidence),pin=clearDigest(copy),before=loadedTaskClearEvidence.pins.length;
  evidenceAppendExpected=structuredClone(copy);
  try {
    const context=requireSerializationContext();if(!context.appendEntry)throw new Error("Task clear owner append unavailable");
    context.appendEntry(TASK_CLEAR_EVIDENCE_TYPE,copy);
    assertTaskClearEvidenceCurrent();
    if(clearDigest(copy)!==pin)throw new Error("Task clear evidence changed during append");
    const next=readClearJournalContinuity(context.getCanonicalEntries?.()??[]);
    if(next.pins.length!==before+1 || next.pins.at(-1)?.digest!==pin)throw new Error("Task clear evidence append unconfirmed");
    loadedTaskClearEvidence=next;
  } finally {evidenceAppendExpected=undefined;}
}

/** Exact inverse of this module's encoder, with no legacy normalization or contract repair. */
function decodeExactClearTask(id:string,raw:Record<string,unknown>,content:Record<string,unknown>|undefined):TodoTask {
  const decoded=structuredClone({...content,...raw}) as unknown as TodoTask;
  delete (decoded as unknown as Record<string,unknown>).contentRef;
  // The encoder alone omits empty resourceUris. Other required domain fields are never defaulted.
  if(decoded.resourceUris===undefined)decoded.resourceUris=[];
  if(decoded.id!==id || !Array.isArray(decoded.resourceUris) || !Array.isArray(decoded.skills) || !Array.isArray(decoded.blockedBy) || !decoded.createdBy || !decoded.assignee)throw new Error("Invalid exact historical Task domain");
  const encodedContent=todoContent(decoded),ref=encodedContent===undefined?undefined:todoContentRef(encodedContent);
  if(JSON.stringify(todoStateTask(decoded,ref))!==JSON.stringify(raw) || JSON.stringify(encodedContent)!==JSON.stringify(content))throw new Error("Task clear exact storage/domain roundtrip differs");
  return decoded;
}

export function loadTasksFromSession(ctx: TodoContext): Map<string, TodoTask> {
  loadedTaskClearEvidence = {pins:[]};
  loadedTaskClearHistory = [];
  const sm = ctx.sessionManager as {
    getBranch?: () => Array<TodoContentEntry>;
  } | undefined;
  let entries: Array<TodoContentEntry>;
  try { entries=sm?.getBranch?.()??[]; } catch { return new Map(); }
  if(!Array.isArray(entries))return new Map();
  loadedTaskClearEvidence = {pins:[]};
  loadedTaskClearEvidence = readClearJournalContinuity(entries);
  const contentsByRef = new Map<string, Record<string, unknown>>();
  persistedTodoContentRefs = new Set<string>();
  persistedContentEntries = new Map<string, string>();
  for (const candidate of entries) {
    if (candidate.type !== "custom" || candidate.customType !== TODO_CONTENT_ENTRY_TYPE) continue;
    const contents = asRecord(asRecord(candidate.data)?.contents);
    if (!contents) continue;
    for (const [ref, rawContent] of Object.entries(contents)) {
      const content = asRecord(rawContent);
      if (!content || todoContentRef(content) !== ref) continue;
      contentsByRef.set(ref, content);
      persistedTodoContentRefs.add(ref);
      if (candidate.id) persistedContentEntries.set(ref, candidate.id);
    }
  }

  const entry = entries
    .filter((e) => e.type === "custom" && e.customType === TODO_STATE_ENTRY_TYPE)
    .pop();
  const data = asRecord(entry?.data);
  if (data?.taskClearHistory !== undefined && !Array.isArray(data.taskClearHistory)) throw new Error("Invalid Task clear history envelope");
  loadedTaskClearHistory = structuredClone((data?.taskClearHistory ?? []) as TaskClearRecord[]);
  for (const record of loadedTaskClearHistory) validateClearRecord(record);
  replacementAllocatorHighWater = undefined;
  if (data?.replacementAllocatorHighWater !== undefined) {
    const value = data.replacementAllocatorHighWater; if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid replacement allocator high-water");
    replacementAllocatorHighWater = value as number;
  }
  const rawTasks = asRecord(data?.tasks);
  if (!rawTasks) { if(data?.taskClearHistory!==undefined)throw new Error("Invalid Task clear state envelope: tasks object is required"); return new Map(); }
  const loaded = new Map<string, TodoTask>();
  for (const [id, rawTask] of Object.entries(rawTasks)) {
    const task = asRecord(rawTask);
    const contentRef = typeof task?.contentRef === "string" ? task.contentRef : undefined;
    const content = contentRef === undefined ? undefined : contentsByRef.get(contentRef);
    const historical=loadedTaskClearHistory.some(r=>r.members.some(m=>m.id===id)) || !!loadedTaskClearEvidence.pending?.intent.record.members.some(m=>m.id===id);
    if(historical && (!task || contentRef && !content))throw new Error("Task clear historical content missing");
    const merged=content && task ? { ...content, ...task } : rawTask;
    const normalized = historical ? decodeExactClearTask(id,task!,content) : normalizeLoadedTask(id,merged);
    if (!historical) initializeTaskContract(normalized);
    loaded.set(id, normalized);
  }
  const replacementGroups = loadDeliveryGroupsFromSession(ctx);
  validateReplacementGroups(replacementGroups, loaded);
  validateClearHistory(loadedTaskClearHistory, loaded, replacementGroups);
  assertTaskClearSnapshots(loadedTaskClearHistory, ctx);
  if(loadedTaskClearEvidence.pending && !loadedTaskClearHistory.some(r=>r.id===loadedTaskClearEvidence.pending!.intent.record.id))assertTaskClearSnapshots([loadedTaskClearEvidence.pending.intent.record],ctx,[...loadedTaskClearHistory,loadedTaskClearEvidence.pending.intent.record]);
  const receipts = replacementGroups.flatMap(group => group.replacementHistory ?? []);
  if (receipts.length && (replacementAllocatorHighWater === undefined || receipts.some(receipt => receipt.allocatorHighWater > replacementAllocatorHighWater!)) || replacementAllocatorHighWater !== undefined && [...loaded.keys()].some(id => /^\d+$/.test(id) && Number(id) > replacementAllocatorHighWater!)) throw new Error("Replacement allocator high-water regressed");
  if (loadedTaskClearHistory.some(r => r.allocatorHighWater > (replacementAllocatorHighWater ?? -1))) throw new Error("Task clear allocator high-water regressed");
  if (loadedTaskClearEvidence.pending || replacementGroups.some(group => group.currentPendingReplacementId) || loadedTaskClearHistory.some(r => r.phase === "reserved")) return loaded;
  normalizeLoadedDependencies(loaded);
  normalizeLoadedGoalBindings(loaded);
  return loaded;
}

/**
 * Drop bindings to Goals that no longer exist, at the session-load boundary.
 *
 * Mirrors {@link normalizeLoadedDependencies}, which does the same for `blockedBy`. Goal state
 * is session-scoped (it clears its registry when the persisted sessionId does not match, and on
 * new/fork), while Todo state is not, so a fork or resume can bring every task back carrying a
 * goalId whose Goal is gone. Nothing validates goalId on the write path either, so a task can
 * also be created against an id that never existed.
 *
 * Safe to resolve Goals here: goalSessionStart runs before todoSessionStart (extension/index.ts),
 * so the registry is already populated.
 */
export function normalizeLoadedGoalBindings(state: Map<string, TodoTask>): void {
  for (const task of state.values()) {
    if (taskIsCleared(loadedTaskClearHistory, task.id)) continue;
    if (task.supersessionId) continue;
    if (!task.goalId) continue;
    if (!goalExists) throw new Error("Todo Goal reader not initialized");
    if (goalExists(task.goalId)) continue;
    delete task.goalId;
  }
}

export function normalizeLoadedDependencies(state: Map<string, TodoTask>): void {
  for (const task of state.values()) {
    if (taskIsCleared(loadedTaskClearHistory, task.id)) continue;
    if (task.supersessionId) continue;
    const seen = new Set<string>();
    task.blockedBy = task.blockedBy.filter((depId) => {
      if (seen.has(depId)) return false;
      seen.add(depId);
      const dependency = state.get(depId);
      return dependency?.status !== "completed" && dependency?.status !== "deleted";
    });
    if (task.status === "pending" || task.status === "blocked") {
      task.status = task.blockedBy.length > 0 ? "blocked" : "pending";
    }
  }
}

export function isTodoMutation(action: TodoParams["action"]): boolean {
  return action !== "list" && action !== "get";
}

export function assertTodoGeneration(generation: number): void {
  if (generation !== requireSerializationContext().getTodoGeneration()) {
    throw new Error("Todo session changed while the mutation was pending; retry against the active session.");
  }
}

export function normalizeLoadedTask(id: string, raw: unknown): TodoTask {
  const task = asRecord(raw) ?? {};
  for (const key of ["replacementPendingId", "supersededByGroupId", "supersessionId"]) if (task[key] !== undefined && (typeof task[key] !== "string" || !(task[key] as string).trim())) throw new Error("Invalid persisted replacement Task marker");
  const contextParts: string[] = [];
  if (typeof task.context === "string" && task.context) contextParts.push(task.context);

  const skills = readSkillBindings(task.skills);
  if (skills.length === 0) appendLegacySkill(skills, task.skill);
  const legacyInject = Array.isArray(task.inject) ? task.inject : [];
  for (const item of legacyInject) {
    const entry = asRecord(item);
    if (!entry || typeof entry.source !== "string") continue;
    if (entry.type === "skill" && skills.length === 0) {
      appendLegacySkill(skills, { name: entry.source });
    } else if (entry.type === "text") {
      contextParts.push(wrapLegacyBlock(typeof entry.tag === "string" ? entry.tag : "content", entry.source));
    } else if (entry.type === "file") {
      contextParts.push(wrapLegacyBlock("legacy_file_reference", entry.source));
    }
  }

  const legacyInjection = asRecord(task.injection);
  if (legacyInjection) {
    if (skills.length === 0 && typeof legacyInjection.skillRef === "string") {
      appendLegacySkill(skills, { name: legacyInjection.skillRef });
    }
    appendLegacyValue(contextParts, "legacy_goal_context", legacyInjection.goalContext);
    appendLegacyValue(contextParts, "step_context", legacyInjection.stepContext);
    appendLegacyValue(contextParts, "boundary_contract", legacyInjection.boundaryContract);
    if (Array.isArray(legacyInjection.deferredReads)) {
      const paths = legacyInjection.deferredReads.filter((value): value is string => typeof value === "string");
      if (paths.length > 0) contextParts.push(wrapLegacyBlock("deferred_reads", paths.join("\n")));
    }
  }

  const legacyLoad = asRecord(task.load);
  if (legacyLoad && typeof legacyLoad.source === "string") {
    if (legacyLoad.type === "skill" && skills.length === 0) {
      appendLegacySkill(skills, { name: legacyLoad.source });
    }
    else if (legacyLoad.type === "text") contextParts.push(legacyLoad.source);
    else if (legacyLoad.type === "file") contextParts.push(wrapLegacyBlock("legacy_file_reference", legacyLoad.source));
  }

  const completion = asRecord(task.completion);
  const summary = typeof task.summary === "string"
    ? task.summary
    : typeof completion?.summary === "string"
      ? completion.summary
      : undefined;
  const status = isTaskStatus(task.status) ? task.status : "pending";
  const blockedBy = Array.isArray(task.blockedBy)
    ? task.blockedBy.filter((value): value is string => typeof value === "string")
    : [];
  const now = Date.now();
  const skillActivation = readSkillActivation(task.skillActivation);
  const legacySkillActivation = skillActivation ?? readLegacySkillActivation(id, task.skillLoad, skills);
  const origin = readTodoOrigin(task.origin);
  const resourceUris = readTodoResourceUris(task.resourceUris);
  const handoff = readTodoHandoff(task.handoff);
  const rootActor = requireSerializationContext().rootActor;
  const createdBy = readTodoActor(task.createdBy) ?? { ...rootActor };
  const assignee = readTodoActor(task.assignee) ?? { ...rootActor };

  return {
    ...(task.reviewRequired === true ? {reviewRequired:true} : {}),
    ...(typeof task.dispatchSubmissionId === "string" ? {dispatchSubmissionId:task.dispatchSubmissionId} : {}),
    ...(typeof task.taskInstanceId === "string" ? { taskInstanceId: task.taskInstanceId } : {}),
    ...(Number.isSafeInteger(task.contractVersion) && (task.contractVersion as number) > 0 ? { contractVersion: task.contractVersion as number } : {}),
    ...(typeof task.contractDigest === "string" ? { contractDigest: task.contractDigest } : {}),
    ...(Array.isArray(task.contractDependencies) ? { contractDependencies: stringArray(task.contractDependencies) } : {}),
    ...(Array.isArray(task.acceptanceCriteria) ? { acceptanceCriteria: stringArray(task.acceptanceCriteria) } : {}),
    ...(task.acceptanceReport && typeof task.acceptanceReport === "object" ? { acceptanceReport: structuredClone(task.acceptanceReport) as TodoTask["acceptanceReport"] } : {}),
    ...(task.skipResolution && typeof task.skipResolution === "object" ? { skipResolution: structuredClone(task.skipResolution) as TodoTask["skipResolution"] } : {}),
    ...Object.fromEntries(["verifiedQualityGateId", "deliveryGoalId", "deliveryGroupId", "replacementPendingId", "supersededByGroupId", "supersessionId"].filter(key => typeof task[key] === "string").map(key => [key, task[key]])),
    id: typeof task.id === "string" ? task.id : id,
    subject: typeof task.subject === "string" ? task.subject : `Task ${id}`,
    ...(typeof task.description === "string" ? { description: task.description } : {}),
    status,
    blockedBy,
    skills,
    resourceUris,
    ...(handoff ? { handoff } : {}),
    ...(contextParts.length > 0 ? { context: contextParts.join("\n\n") } : {}),
    ...(legacySkillActivation ? { skillActivation: legacySkillActivation } : {}),
    ...(summary ? { summary } : {}),
    ...(origin ? { origin } : {}),
    ...(typeof task.planHandoffKey === "string" ? { planHandoffKey: task.planHandoffKey } : {}),
    ...(typeof task.goalId === "string" ? { goalId: task.goalId } : {}),
    createdBy,
    assignee,
    createdAt: typeof task.createdAt === "number" ? task.createdAt : now,
    updatedAt: typeof task.updatedAt === "number" ? task.updatedAt : now,
    ...(status === "in_progress" && typeof task.activeStartedAt === "number" && Number.isFinite(task.activeStartedAt)
      ? { activeStartedAt: task.activeStartedAt }
      : {}),
    ...(typeof task.activeDurationMs === "number" && Number.isFinite(task.activeDurationMs) && task.activeDurationMs >= 0
      ? { activeDurationMs: task.activeDurationMs }
      : {}),
    ...(status === "completed" && typeof task.completedAt === "number" && Number.isFinite(task.completedAt)
      ? { completedAt: task.completedAt }
      : {}),
  };
}

export function readTodoOrigin(value: unknown): TodoTaskOrigin | undefined {
  const origin = asRecord(value);
  if (!origin || typeof origin.sessionId !== "string" || typeof origin.step !== "string") return undefined;
  return {
    sessionId: origin.sessionId,
    step: origin.step,
    ...(typeof origin.sessionGeneration === "string" ? { sessionGeneration: origin.sessionGeneration } : {}),
    ...(typeof origin.runId === "string" ? { runId: origin.runId } : {}),
    ...(typeof origin.runSeq === "string" ? { runSeq: origin.runSeq } : {}),
  };
}

export function readTodoActor(value: unknown): TodoActorRef | undefined {
  const actor = asRecord(value);
  if (
    !actor
    || (actor.kind !== "root" && actor.kind !== "teammate")
    || typeof actor.id !== "string"
    || !actor.id
    || typeof actor.label !== "string"
    || !actor.label
  ) return undefined;
  return {
    kind: actor.kind,
    id: actor.id,
    label: actor.label,
    ...(typeof actor.agentType === "string" ? { agentType: actor.agentType } : {}),
  };
}

export function readSkillBindings(value: unknown): TodoSkillBinding[] {
  if (!Array.isArray(value)) return [];
  const bindings: TodoSkillBinding[] = [];
  for (const item of value) {
    const binding = readSkillBinding(item);
    if (binding) bindings.push(binding);
  }
  return bindings;
}

export function readSkillBinding(value: unknown): TodoSkillBinding | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  if (!isSkillRole(skill.role)) return undefined;
  return normalizeSkillBinding({
    name: skill.name,
    role: skill.role,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

export function readSkillConfig(value: unknown): TodoSkillConfig | undefined {
  const skill = asRecord(value);
  if (!skill || typeof skill.name !== "string" || !skill.name.trim()) return undefined;
  return normalizeSkillConfig({
    name: skill.name,
    ...(typeof skill.args === "string" ? { args: skill.args } : {}),
  });
}

export function appendLegacySkill(bindings: TodoSkillBinding[], value: unknown): void {
  const skill = readSkillConfig(value);
  if (skill) bindings.push({ ...skill, role: "primary" });
}

export function readSkillActivation(value: unknown): SkillActivationMetadata | undefined {
  const record = asRecord(value);
  if (
    !record
    || typeof record.activationId !== "string"
    || typeof record.stackRevision !== "string"
    || typeof record.activatedAt !== "number"
    || typeof record.validatedAt !== "number"
    || !["active", "stale"].includes(String(record.state))
  ) return undefined;
  const bindings = readActivationBindings(record.bindings);
  return {
    activationId: record.activationId,
    stackRevision: record.stackRevision,
    activatedAt: record.activatedAt,
    validatedAt: record.validatedAt,
    state: record.state as SkillActivationMetadata["state"],
    bindings,
  };
}

export function readActivationBindings(value: unknown): SkillActivationBindingMetadata[] {
  if (!Array.isArray(value)) return [];
  const bindings: SkillActivationBindingMetadata[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (
      !record
      || !isSkillRole(record.role)
      || typeof record.name !== "string"
      || typeof record.filePath !== "string"
    ) continue;
    bindings.push({
      role: record.role,
      name: record.name,
      ...(typeof record.args === "string" ? { args: record.args } : {}),
      filePath: record.filePath,
      contentHash: typeof record.contentHash === "string" ? record.contentHash : "",
      configHash: typeof record.configHash === "string" ? record.configHash : "",
      requiredReadingHash: typeof record.requiredReadingHash === "string" ? record.requiredReadingHash : "",
      ...(Array.isArray(record.requiredReadingContentHashes)
        ? { requiredReadingContentHashes: stringArray(record.requiredReadingContentHashes) }
        : {}),
      compiledKey: typeof record.compiledKey === "string" ? record.compiledKey : "",
      requiredFiles: stringArray(record.requiredFiles),
      deferredFiles: stringArray(record.deferredFiles),
      totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    });
  }
  return bindings;
}

export function readLegacySkillActivation(
  taskId: string,
  value: unknown,
  skills: readonly TodoSkillBinding[],
): SkillActivationMetadata | undefined {
  const record = asRecord(value);
  const primary = skills.find((skill) => skill.role === "primary") ?? skills[0];
  if (!record || !primary || typeof record.filePath !== "string") return undefined;
  const activatedAt = typeof record.loadedAt === "string" ? Date.parse(record.loadedAt) : Date.now();
  return {
    activationId: `legacy-${taskId}`,
    stackRevision: "",
    activatedAt: Number.isFinite(activatedAt) ? activatedAt : Date.now(),
    validatedAt: Number.isFinite(activatedAt) ? activatedAt : Date.now(),
    state: "stale",
    bindings: [{
      role: primary.role,
      name: primary.name,
      ...(primary.args ? { args: primary.args } : {}),
      filePath: record.filePath,
      contentHash: "",
      configHash: "",
      requiredReadingHash: "",
      compiledKey: "",
      requiredFiles: stringArray(record.requiredFiles),
      deferredFiles: stringArray(record.deferredFiles),
      totalBytes: typeof record.totalBytes === "number" ? record.totalBytes : 0,
    }],
  };
}

export function appendLegacyValue(parts: string[], tag: string, value: unknown): void {
  if (typeof value === "string" && value) parts.push(wrapLegacyBlock(tag, value));
}

export function wrapLegacyBlock(tag: string, value: string): string {
  return `<${tag}>\n${value}\n</${tag}>`;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return ["pending", "in_progress", "completed", "blocked", "deleted"].includes(String(value));
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** Exact readback of our own state publication; not a filesystem durability ACK. */
export function matchesTodoStatePublication(data:unknown,state:Map<string,TodoTask>):boolean {
  const groups = requireSerializationContext().getDeliveryGroups?.() ?? [];
  return JSON.stringify(data)===JSON.stringify(encodeTodoPublication(state, groups).state);
}

export function loadDeliveryGroupsFromSession(ctx: TodoContext): DeliveryGroup[] {
  const entries = (ctx.sessionManager as {getBranch?: () => {type?:string;customType?:string;data?:unknown}[]} | undefined)?.getBranch?.() ?? [];
  const data = asRecord(entries.filter(entry => entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE).at(-1)?.data);
  return readDeliveryGroups(data?.deliveryGroups);
}

/** A positive host admission trace can only make restoration more conservative. */
export function restoreTaskSubmissionMarkers(ctx: TodoContext, state: Map<string,TodoTask>): void {
  const branch=(ctx.sessionManager as {getBranch?:()=>{type?:string;customType?:string;data?:unknown}[]}|undefined)?.getBranch?.()??[];
  for(const entry of branch){
    if(entry.type!=="custom"||entry.customType!=="pi-graph-next:task-dispatch-prepared/1")continue;
    const data=asRecord(entry.data);if(typeof data?.intentId!=="string"||!Array.isArray(data.ownedContracts))continue;
    for(const raw of data.ownedContracts){const core=asRecord(raw);if(typeof core?.taskId!=="string"||typeof core.taskInstanceId!=="string")continue;const task=state.get(core.taskId);if(!taskIsCleared(loadedTaskClearHistory,core.taskId)&&task?.taskInstanceId===core.taskInstanceId)task.dispatchSubmissionId??=data.intentId;}
  }
}
/** Canonical branch snapshots for explicit output-only restoration. No source write, UUID minting, or normalization of missing evidence. */
export function readRecoveryTaskHistory(ctx:TodoContext,id:string):{entryId:string;task?:TodoTask}[] {
  const branch=(ctx.sessionManager as {getBranch?:()=>{id?:string;type?:string;customType?:string;data?:unknown}[]}|undefined)?.getBranch?.()??[];
  const contents=new Map<string,Record<string,unknown>>(),history:{entryId:string;task?:TodoTask}[]=[];
  for(const entry of branch){
    if(entry.type!=="custom")continue;
    if(entry.customType===TODO_CONTENT_ENTRY_TYPE){for(const [ref,raw] of Object.entries(asRecord(asRecord(entry.data)?.contents)??{})){const content=asRecord(raw);if(content&&todoContentRef(content)===ref)contents.set(ref,content);}continue;}
    if(entry.customType!==TODO_STATE_ENTRY_TYPE||!entry.id)continue;
    const raw=asRecord(asRecord(asRecord(entry.data)?.tasks)?.[id]);
    if(!raw){history.push({entryId:entry.id});continue;}
    const ref=typeof raw.contentRef==="string"?raw.contentRef:undefined,content=ref?contents.get(ref):undefined;
    if(ref&&!content)throw new Error("Native recovery Task history material is missing");
    if(typeof raw.taskInstanceId!=="string"||!Number.isSafeInteger(raw.contractVersion))throw new Error("Native recovery historical Task contract identity is missing");
    history.push({entryId:entry.id,task:normalizeLoadedTask(id,{...content,...raw})});
  }
  return history;
}


export function captureTaskClearSnapshot(): TaskClearRecord["snapshot"] {
  const entries=requireSerializationContext().getCanonicalEntries?.()??[];
  const entry=entries.filter(e=>e.type==="custom"&&e.customType===TODO_STATE_ENTRY_TYPE).at(-1);
  if(!entry?.id)throw new Error("Task clear requires an exact canonical Task publication");
  const data=asRecord(entry.data),rawTasks=asRecord(data?.tasks);if(!rawTasks)throw new Error("Task clear snapshot Tasks unavailable");
  const refs=new Set(Object.values(rawTasks).flatMap(raw=>{const task=asRecord(raw);return typeof task?.contentRef==="string"?[task.contentRef]:[];}));
  return {entryId:entry.id,stateDigest:todoContentRef(entry.data as Record<string,unknown>),contents:[...refs].map(ref=>{const id=persistedContentEntries.get(ref);if(!id)throw new Error("Task clear snapshot content source missing");return {ref,entryId:id};})};
}
export function assertTaskClearSnapshots(records:readonly TaskClearRecord[],ctx:Pick<TodoContext,"cwd"|"sessionManager">,history:readonly TaskClearRecord[]=records):void {
  if(!records.length)return;
  const manager=ctx.sessionManager as {getSessionId():string;getBranch():{id?:string;parentId?:string|null;type?:string;customType?:string;data?:unknown}[]};
  const branch=manager.getBranch();
  for(const record of records){
    const index=history.findIndex(item=>item.id===record.id);
    if(index<0)throw new Error("Task clear history record missing");
    assertClearSnapshot(record,branch,realpathSync(ctx.cwd),manager.getSessionId());
    const entry=branch.find(e=>e.id===record.snapshot.entryId)!,data=asRecord(entry.data)!,state=asRecord(data.tasks)!;
    const earlier=Array.isArray(data.taskClearHistory)?data.taskClearHistory as TaskClearRecord[]:[];
    for(const prior of earlier)validateClearRecord(prior);
    if(earlier.some(prior=>prior.phase!=="complete") || JSON.stringify(earlier)!==JSON.stringify(history.slice(0,index)))throw new Error("Task clear immutable history prefix differs");
    const expectedIds=Object.keys(state).filter(id=>!taskIsCleared(earlier,id));
    if(expectedIds.length!==record.members.length || expectedIds.some(id=>!record.members.some(m=>m.id===id)))throw new Error("Task clear original membership is incomplete");
    const originalGroups=Array.isArray(data.deliveryGroups)?data.deliveryGroups as DeliveryGroup[]:[];
    const expectedGroups=originalGroups.filter(g=>g.members.every(m=>expectedIds.includes(m.taskId)));
    if(expectedGroups.length!==record.groups.length || expectedGroups.some(g=>!record.groups.some(pin=>pin.id===g.id)))throw new Error("Task clear original groups are incomplete");
    for(const member of record.members){
      const content=todoContent(member.body),ref=content===undefined?undefined:todoContentRef(content);
      if(JSON.stringify(state[member.id])!==JSON.stringify(todoStateTask(member.body,ref)))throw new Error("Task clear body differs from immutable journal snapshot");
      if(ref && !record.snapshot.contents.some(pin=>pin.ref===ref))throw new Error("Task clear member content pin missing");
    }
    const groups=Array.isArray(data.deliveryGroups)?data.deliveryGroups:[];
    for(const group of record.groups)if(!groups.some(value=>todoContentRef(value as Record<string,unknown>)===group.digest))throw new Error("Task clear group differs from immutable journal snapshot");
  }
}
