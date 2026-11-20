import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  assertTodoSourceScope, captureTodoSourceScope, readTodoSourceServices,
  subscribeTodoSourceInvalidation, type TodoSourceScope,
} from "pi-maestro-teammate/v1/todo-context";
import type { TodoTask } from "./types.ts";
import type { TodoHandoffAdviceSnapshot, applyTodoHandoffAdviceCAS } from "./commands.ts";
import type { TodoHandoffFileInput } from "../tools/todo-contract.ts";

export interface CanonicalTodoServices {
  readonly version: 1;
  readTasks(scope: TodoSourceScope, ctx: ExtensionContext): TodoTask[];
  subscribe(scope: TodoSourceScope, ctx: ExtensionContext, listener: () => void): () => void;
  listHandoff(scope: TodoSourceScope, ctx: ExtensionContext): TodoTask[];
  captureHandoff(scope: TodoSourceScope, ctx: ExtensionContext, taskId: string): TodoHandoffAdviceSnapshot;
  assertHandoff(scope: TodoSourceScope, ctx: ExtensionContext, snapshot: TodoHandoffAdviceSnapshot): void;
  applyHandoff(
    scope: TodoSourceScope, ctx: ExtensionContext, snapshot: TodoHandoffAdviceSnapshot,
    files: readonly TodoHandoffFileInput[], assertAuthorizedCurrent: () => void,
  ): ReturnType<typeof applyTodoHandoffAdviceCAS>;
}

interface CanonicalGrant { readonly scope: TodoSourceScope; readonly services: CanonicalTodoServices; }
const handoffGrants = new WeakMap<TodoHandoffAdviceSnapshot, CanonicalGrant>();
const serviceMethods = ["readTasks", "subscribe", "listHandoff", "captureHandoff", "assertHandoff", "applyHandoff"] as const;

function assertGrant(grant: CanonicalGrant): void {
  assertTodoSourceScope(grant.scope);
  if (readTodoSourceServices(grant.scope) !== grant.services) throw new Error("Todo canonical services were replaced.");
}

function captureGrant(ctx: ExtensionContext): CanonicalGrant {
  const manager = ctx.sessionManager;
  const sessionId = manager?.getSessionId?.();
  if (!manager || !sessionId || !ctx.cwd) throw new Error("Todo canonical host/session/workspace is unavailable.");
  const scope = captureTodoSourceScope({ manager, sessionId, cwd: ctx.cwd });
  if (!scope) throw new Error("Todo canonical source is unavailable.");
  const raw = readTodoSourceServices(scope) as Partial<CanonicalTodoServices>;
  if (raw.version !== 1 || Object.keys(raw).length !== serviceMethods.length + 1
    || serviceMethods.some(method => typeof raw[method] !== "function")) {
    throw new Error("Todo canonical host services have an unsupported shape.");
  }
  return { scope, services: raw as CanonicalTodoServices };
}

function handoffGrant(snapshot: TodoHandoffAdviceSnapshot): CanonicalGrant {
  const grant = handoffGrants.get(snapshot);
  if (!grant) throw new Error("Todo handoff snapshot was not issued to this canonical host.");
  assertGrant(grant);
  return grant;
}

export function readCanonicalTodoTasks(ctx: ExtensionContext): TodoTask[] {
  const grant = captureGrant(ctx);
  const tasks = grant.services.readTasks(grant.scope, ctx);
  assertGrant(grant);
  return tasks;
}

export function subscribeCanonicalTodoChanges(ctx: ExtensionContext, listener: () => void): () => void {
  const grant = captureGrant(ctx);
  let closed = false;
  let disposeInvalidation: (() => void) | undefined;
  const disposeChanges = grant.services.subscribe(grant.scope, ctx, () => {
    if (closed) return;
    assertGrant(grant);
    listener();
  });
  const dispose = () => {
    if (closed) return;
    closed = true;
    disposeChanges();
    disposeInvalidation?.();
  };
  try {
    disposeInvalidation = subscribeTodoSourceInvalidation(grant.scope, dispose);
    if (closed) disposeInvalidation();
    else assertGrant(grant);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}

export function listCanonicalTodoHandoffTasks(ctx: ExtensionContext): TodoTask[] {
  const grant = captureGrant(ctx);
  const tasks = grant.services.listHandoff(grant.scope, ctx);
  assertGrant(grant);
  return tasks;
}

export function captureCanonicalTodoHandoff(ctx: ExtensionContext, taskId: string): TodoHandoffAdviceSnapshot {
  const grant = captureGrant(ctx);
  const snapshot = grant.services.captureHandoff(grant.scope, ctx, taskId);
  assertGrant(grant);
  handoffGrants.set(snapshot, grant);
  return snapshot;
}

export function assertCanonicalTodoHandoff(ctx: ExtensionContext, snapshot: TodoHandoffAdviceSnapshot): void {
  const grant = handoffGrant(snapshot);
  grant.services.assertHandoff(grant.scope, ctx, snapshot);
  assertGrant(grant);
}

export function applyCanonicalTodoHandoff(
  ctx: ExtensionContext, snapshot: TodoHandoffAdviceSnapshot,
  files: readonly TodoHandoffFileInput[], assertAuthorizedCurrent: () => void,
): ReturnType<typeof applyTodoHandoffAdviceCAS> {
  const grant = handoffGrant(snapshot);
  return grant.services.applyHandoff(grant.scope, ctx, snapshot, files, () => {
    assertGrant(grant);
    assertAuthorizedCurrent();
  });
}
