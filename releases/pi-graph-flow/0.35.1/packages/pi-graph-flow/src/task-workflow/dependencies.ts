import { taskDependencySatisfied } from "./acceptance.ts";
import type { TodoTask } from "./types.ts";
import { cloneTodoTask } from "./state.ts";
export function resolveBlockedByInState(
  taskId: string,
  proposedDeps: readonly string[],
  state: Map<string, TodoTask>,
): { blockedBy: string[]; error?: string } {
  const blockedBy: string[] = [];
  const seen = new Set<string>();
  for (const rawDepId of proposedDeps) {
    const depId = rawDepId.replace(/^#+/, "");
    if (seen.has(depId)) continue;
    seen.add(depId);
    if (depId === taskId) return { blockedBy: [], error: "Task cannot block itself" };
    const dependency = state.get(depId);
    if (!dependency) {
      return { blockedBy: [], error: `blockedBy references unknown task: ${depId}` };
    }
    if (dependency.status === "deleted") {
      return { blockedBy: [], error: `blockedBy references deleted task: ${depId}` };
    }
    if (taskDependencySatisfied(state,depId)) continue;
    blockedBy.push(depId);
  }
  if (hasCycle(taskId, blockedBy, state)) {
    return { blockedBy: [], error: "blockedBy would create a dependency cycle" };
  }
  return { blockedBy };
}

export function deriveDependencyStatus(blockedBy: readonly string[]): "blocked" | "pending" {
  return blockedBy.length > 0 ? "blocked" : "pending";
}

export function hasCycle(
  taskId: string,
  proposedDeps: string[],
  state: Map<string, TodoTask>,
): boolean {
  const visited = new Set<string>();
  const stack = [...proposedDeps];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const dep = state.get(current);
    if (dep) stack.push(...dep.blockedBy);
  }
  return false;
}

export function autoUnblock(state: Map<string, TodoTask>, completedId: string): void {
  for (const [id, t] of state) {
    if (t.status === "deleted") continue;
    if (!t.blockedBy.includes(completedId)) continue;
    const next = cloneTodoTask(t);
    next.blockedBy = next.blockedBy.filter((d) => d !== completedId);
    if (next.status === "blocked" || next.status === "pending") {
      next.status = deriveDependencyStatus(next.blockedBy);
    }
    next.updatedAt = Date.now();
    state.set(id, next);
  }
}

