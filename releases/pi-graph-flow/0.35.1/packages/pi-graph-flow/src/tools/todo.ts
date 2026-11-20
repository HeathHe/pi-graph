import { readModelUsageFact } from "../sdk-host/goal-budget-host.ts";
import { readChildModelUsageFact } from "pi-maestro-teammate/v1/task-dispatch-binding";
import { captureGoalBudget, subscribeGoalBudget, captureSelectedGoalBudget, assertNoGoalBudget, readGoalBudget, assertGoalBudgetCoverage, initialGoalBudgetHistory, goalBudgetCoverageInfo, captureGoalCoverageClose, adoptGoalCoverage, restoredGoalCoverage } from "../goal-coordinator/state.ts";
/** Compatibility composition root; canonical Task state lives only in task-workflow. */
import * as storage from "./todo-serialization.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as skills from "./todo-skill-engine.ts";
import * as compaction from "../compaction/compaction-settings.ts";
import { fenceTaskClear, getActiveGoal, getGoalById, switchCurrentGoal, preparePlanReplacement, rebindPlanReplacement, assertPlanReplacementPublication, assertPlanReplacementHistory, resumeAfterPlanReplacementRecovery } from "./goal.ts";
import { TodoSkillLoader } from "../skills/skill-loader.ts";
import { SkillRuntime } from "../skills/skill-runtime.ts";
import { configureTaskWorkflowPorts } from "../task-workflow/commands.ts";
storage.configureTodoGoalReader(getGoalById);
configureTaskWorkflowPorts({ storage, skills, compaction, getAgentDataDir:getAgentDir,
  modelUsageFacts: { read: readModelUsageFact },
  childModelUsageFacts: { read: readChildModelUsageFact },
  goals: { budget: { subscribe: subscribeGoalBudget, capture: captureGoalBudget, captureSelected: captureSelectedGoalBudget, assertNone: assertNoGoalBudget, read: readGoalBudget, assertCoverage: assertGoalBudgetCoverage, initialHistory: initialGoalBudgetHistory, coverageInfo: goalBudgetCoverageInfo, captureCoverageClose: captureGoalCoverageClose, adoptCoverage: adoptGoalCoverage, restoredCoverage: restoredGoalCoverage }, fenceTaskClear, getActiveGoal, getGoalById, switchCurrentGoal, preparePlanReplacement, rebindPlanReplacement, assertPlanReplacementPublication, assertPlanReplacementHistory, resumeAfterPlanReplacement: (id, ctx) => resumeAfterPlanReplacementRecovery(ctx, id) },
  createSkillLoader: cwd => new TodoSkillLoader({ cwd }),
  createSkillRuntime: loader => new SkillRuntime(loader),
});
export * from "../task-workflow/commands.ts";
