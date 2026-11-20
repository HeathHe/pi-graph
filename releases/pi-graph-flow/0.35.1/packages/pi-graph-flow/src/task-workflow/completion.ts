import { assertTaskAcceptance } from "./acceptance.ts";
import type { TodoTask } from "./types.ts";
import type { GoalView } from "./ports.ts";
export function autoCompletionPendingReason(task: TodoTask, goal: GoalView | undefined): string | undefined {
  try { assertTaskAcceptance(task); } catch (error) { return String(error); }
  if (!task.goalId) return undefined;
  if (!goal || goal.status !== "done") return `pending-review: quality gate Goal ${task.goalId} has not confirmed completion.`;
  return undefined;
}
