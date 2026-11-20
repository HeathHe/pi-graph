import type { TodoTask, TaskStatus } from "./types.ts";
/** All Task fields are serializable data. Never expose the canonical object graph. */
export function cloneTodoTask(task: TodoTask): TodoTask { return structuredClone(task); }
export function cloneTaskMap(state: ReadonlyMap<string, TodoTask>): Map<string, TodoTask> {
  return new Map([...state].map(([id, task]) => [id, cloneTodoTask(task)]));
}
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ["in_progress", "blocked", "completed", "deleted"],
  in_progress: ["completed", "blocked", "pending", "deleted"],
  completed: ["pending", "blocked", "deleted"],
  blocked: ["pending", "in_progress", "deleted"],
  deleted: [],
};

export function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function applyTaskStatusTiming(before: TodoTask, draft: TodoTask, changedAt = Date.now()): void {
  if (before.status === draft.status) return;
  if (before.status === "in_progress") {
    if (before.activeStartedAt !== undefined) {
      draft.activeDurationMs = (before.activeDurationMs ?? 0) + Math.max(0, changedAt - before.activeStartedAt);
    }
    delete draft.activeStartedAt;
  }
  if (draft.status === "in_progress") {
    draft.activeStartedAt = changedAt;
    delete draft.completedAt;
  } else if (draft.status === "completed") {
    draft.completedAt = changedAt;
  }
}

