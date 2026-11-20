import { validateReplacementGroups, type PlanReplacementReceipt } from "./plan-replacement.ts";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PlanStore, type LoadedApprovedPlan } from "../tools/plan-store.ts";
import type { TodoBatchSpec, TodoTask } from "./types.ts";
import { digest } from "../verification/material-review.ts";
export interface DeliveryGroup {
  replacementHistory?: PlanReplacementReceipt[];
  currentPendingReplacementId?: string;
  supersededBy?: { replacementId: string; groupId: string };
  supersedes?: { replacementId: string; groupId: string };
  id: string; deliveryGoalId?: string; createdAt: number;
  source: { cwd: string; sessionId: string; branchAnchor: string };
  sourceKind: "approved-plan" | "root-declaration";
  approvedPlan?: { handoffKey: string; revision: number; checksum: string };
  members: { taskId: string; taskInstanceId: string; required: boolean; skipPolicy?: string }[];
}
export function readTaskHost(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">): DeliveryGroup["source"] {
  const manager = ctx.sessionManager;
  const sessionId = manager?.getSessionId?.();
  const branch = manager?.getBranch?.();
  const branchAnchor = manager?.getLeafId?.() ?? branch?.at(-1)?.id;
  if (!sessionId || !branchAnchor || !Array.isArray(branch)) throw new Error("Canonical Task branch source unavailable.");
  return { cwd: ctx.cwd, sessionId, branchAnchor };
}
export async function readApprovedTaskPlan(ctx: ExtensionContext): Promise<LoadedApprovedPlan> {
  const source = readTaskHost(ctx);
  return new PlanStore(source.cwd, { session: { id: source.sessionId } }).loadApprovedSnapshotReadOnly();
}
export function newDeliveryGroup(created: readonly TodoTask[], specs: readonly TodoBatchSpec[], source: DeliveryGroup["source"], deliveryGoalId?: string, approved?: LoadedApprovedPlan): DeliveryGroup {
  if (!created.length) throw new Error("Complete delivery group must contain the whole non-empty batch.");
  const members = created.map((task, index) => {
    const spec = specs[index]!;
    if (spec.optional && !spec.skipPolicy?.trim()) throw new Error("Optional delivery members require an advance skipPolicy.");
    if (!spec.optional && spec.skipPolicy !== undefined) throw new Error("Required members cannot declare a skip policy.");
    if (deliveryGoalId && task.goalId === deliveryGoalId) throw new Error("A parent delivery Goal cannot also be its member's quality gate.");
    return { taskId: task.id, taskInstanceId: task.taskInstanceId!, required: spec.optional !== true, ...(spec.skipPolicy ? { skipPolicy: spec.skipPolicy.trim() } : {}) };
  });
  return { id: randomUUID(), createdAt: Date.now(), source: structuredClone(source), sourceKind: approved ? "approved-plan" : "root-declaration",
    ...(deliveryGoalId ? { deliveryGoalId } : {}), ...(approved ? { approvedPlan: { handoffKey: approved.manifest.handoffKey!, revision: approved.manifest.revision, checksum: approved.manifest.approvedChecksum! } } : {}), members };
}
export function deliveryGroupDigest(group: DeliveryGroup): string { return digest(group); }
export function readDeliveryGroups(value: unknown): DeliveryGroup[] {
  if (!Array.isArray(value)) return [];
  const result = value.filter((raw): raw is DeliveryGroup => {
    if (!raw || typeof raw !== "object") return false;
    const group = raw as Partial<DeliveryGroup>;
    return typeof group.id === "string" && (group.sourceKind === "approved-plan" || group.sourceKind === "root-declaration")
      && typeof group.source?.cwd === "string" && typeof group.source.sessionId === "string" && typeof group.source.branchAnchor === "string"
      && Array.isArray(group.members) && group.members.length > 0 && group.members.every(member => typeof member.taskId === "string" && typeof member.taskInstanceId === "string" && typeof member.required === "boolean")
      && new Set(group.members.map(member => member.taskId)).size === group.members.length;
  }).map(group => structuredClone(group));
  if (value.some(raw => raw && typeof raw === "object" && ["replacementHistory", "currentPendingReplacementId", "supersededBy", "supersedes"].some(key => key in raw)) && result.length !== value.length) throw new Error("Malformed replacement group cannot be discarded");
  validateReplacementGroups(result);
  return result;
}
