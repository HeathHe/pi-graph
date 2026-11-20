import { taskExecutionInputDigest } from "./execution-contract.ts";
import { createHash } from "node:crypto";
import type { TodoTask } from "./types.ts";
export const taskDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
/** Only the single Task writer supplies this provenance, after its normal validation. */
export interface TaskProgressCommit {
  readonly authoredDependencies?: readonly string[];
  readonly completed?: readonly string[];
  readonly activated?: readonly string[];
}
const progressFields = ["status", "updatedAt", "activeStartedAt", "activeDurationMs", "completedAt", "skillActivation"];
function without(task: TodoTask, fields: readonly string[]): unknown {
  const result = { ...task } as Record<string, unknown>;
  for (const key of fields) delete result[key];
  return result;
}
/** Exact structural check supplements, never substitutes for, writer provenance. */
function legitimateProgress(id: string, before: TodoTask | undefined, after: TodoTask | undefined, source?: TaskProgressCommit): boolean {
  if (!before || !after || !source || source.authoredDependencies?.includes(id)) return false;
  if (source.completed?.includes(id) && before.status !== "completed" && after.status === "completed") {
    const fields = [...progressFields, "summary", "resourceUris", "handoff"];
    return taskDigest(without(before, fields)) === taskDigest(without(after, fields));
  }
  if (source.activated?.includes(id) && before.status === "pending" && after.status === "in_progress" && before.blockedBy.length === 0) {
    return taskDigest(without(before, progressFields)) === taskDigest(without(after, progressFields));
  }
  const remaining = before.blockedBy.filter(dep => !source.completed?.includes(dep));
  if (remaining.length === before.blockedBy.length) return false;
  const expectedStatus = before.status === "blocked" ? (remaining.length ? "blocked" : "pending") : before.status;
  return after.status === expectedStatus && taskDigest(after.blockedBy) === taskDigest(remaining)
    && taskDigest(without(before, ["blockedBy", "status", "updatedAt"])) === taskDigest(without(after, ["blockedBy", "status", "updatedAt"]));
}
export function createTaskVersions() {
  const contracts = new Map<string, number>();
  const states = new Map<string, number>();
  const completed = new Map<string, Set<number>>();
  return {
    contract: (id: string) => contracts.get(id) ?? 0,
    state: (id: string) => states.get(id) ?? 0,
    wasCompleted: (id:string,version:number) => completed.get(id)?.has(version) ?? false,
    reset(tasks: Map<string, TodoTask>) {
      contracts.clear(); states.clear(); completed.clear();
      for (const id of tasks.keys()) { contracts.set(id, 1); states.set(id, 1); }
    },
    committed(before: Map<string, TodoTask>, after: Map<string, TodoTask>, source?: TaskProgressCommit) {
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        if (taskDigest(before.get(id)) === taskDigest(after.get(id))) continue;
        states.set(id, (states.get(id) ?? 0) + 1);
        const progress = legitimateProgress(id, before.get(id), after.get(id), source);
        const old = before.get(id), next = after.get(id);
        if (old?.taskInstanceId && next?.taskInstanceId) {
          if (old.taskInstanceId !== next.taskInstanceId || taskExecutionInputDigest(old) !== taskExecutionInputDigest(next)) contracts.set(id,(contracts.get(id)??0)+1);
        } else if (!progress) contracts.set(id,(contracts.get(id)??0)+1);
        if(source?.completed?.includes(id)&&after.get(id)?.status==="completed") {
          const history=completed.get(id)??new Set<number>();history.add(contracts.get(id)??0);completed.set(id,history);
        }
      }
    },
  };
}
