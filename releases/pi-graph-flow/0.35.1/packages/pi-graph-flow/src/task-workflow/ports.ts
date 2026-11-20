import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TodoSkillLoader } from "../skills/skill-loader.ts";
import type { SkillRuntime } from "../skills/skill-runtime.ts";
export interface GoalView { id: string; text: string; status: string; pauseReason?: string; tokenBudget?: number; }
export interface TaskWorkflowPorts {
  childModelUsageFacts?: { read(fact: object, request: object): { readonly units: number; readonly entryId: string; readonly digest: string } };
  modelUsageFacts?: { read(fact: object, request: object, manager: object): { readonly units: number; readonly entryId: string; readonly digest: string } };
  /** Trusted host resolver, never a model parameter. */
  getAgentDataDir?:()=>string;
  readApprovedPlan?(ctx: ExtensionContext): Promise<import("../tools/plan-store.ts").LoadedApprovedPlan>;
  goals: { budget?: import("../goal-coordinator/budget-source.ts").GoalBudgetSourcePort; fenceTaskClear?(ids:readonly string[]):void; getActiveGoal(): GoalView | undefined; getGoalById(id: string): GoalView | undefined;
    assertPlanReplacementHistory?(receipt: import("./plan-replacement.ts").PlanReplacementReceipt, ctx: { sessionManager?: unknown }): void;
    assertPlanReplacementPublication?(id: string, publication: NonNullable<import("./plan-replacement.ts").PlanReplacementReceipt["goalPublication"]>, ctx: ExtensionContext): void;
    resumeAfterPlanReplacement?(id: string, ctx: ExtensionContext): Promise<void>;
    preparePlanReplacement?(id: string, ctx: ExtensionContext): NonNullable<import("./plan-replacement.ts").PlanReplacementReceipt["parentGoal"]>;
    rebindPlanReplacement?(replacementId: string, ctx: ExtensionContext): Promise<NonNullable<import("./plan-replacement.ts").PlanReplacementReceipt["goalPublication"]>>;
    switchCurrentGoal(id: string, ctx: ExtensionContext, options: { resume: boolean }): unknown; };
  storage: typeof import("../tools/todo-serialization.ts");
  skills: typeof import("../tools/todo-skill-engine.ts");
  createSkillLoader(cwd: string): TodoSkillLoader;
  createSkillRuntime(loader: TodoSkillLoader): SkillRuntime;
  compaction: { isNewContextCompactionEnabled(cwd: string): boolean; NEW_CONTEXT_DISABLED_MESSAGE: string; };
}
