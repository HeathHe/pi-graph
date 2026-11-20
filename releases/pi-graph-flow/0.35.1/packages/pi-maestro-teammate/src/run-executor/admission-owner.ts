import type { TodoSourceScope } from "../runs/todo-source-context.ts";
import type { ChildTodoParentContext } from "../runs/child-parent-context.ts";
import type { NativeCurrentReadCapability } from "./native-current-view.ts";
import type { TaskDispatchHost, PreparedTaskDispatch, TaskDispatchObservation } from "../public/v1/task-dispatch-binding.ts";
import type { NativeExecutionSnapshot } from "./native-observation.ts";
import type { SelectionDecision } from "pi-graph-model-role";
import type { spawn, ChildProcess } from "node:child_process";
import type { createHash, randomUUID } from "node:crypto";
import type * as fs from "node:fs";
import type * as os from "node:os";
import type * as path from "node:path";
import type { Writable } from "node:stream";
import type { StringDecoder } from "node:string_decoder";
import type { fileURLToPath } from "node:url";
import type { describeStructuredOutputValueValidationFailure as describeDeclaredValueFailure, parseDeclaredJsonResult } from "pi-graph-verification";
import type crossSpawn from "cross-spawn";
import type { listAgentSummaries, resolveAgent, AgentConfig } from "../agents/agents.ts";
import type { resolvePiAgentDirectory } from "../shared/agent-directory.ts";
import type { resolveReplyTo, ReplyTarget } from "../shared/routing.ts";
import type {
  SingleResult,
  Usage,
  AgentProgress,
  AgentTerminalStatus,
  AgentTurnEvent,
  AgentTurnTriggerContextV1,
  MessageProvenanceV1,
  TeammateResultPublicationResult,
} from "../shared/types.ts";
import type { RuntimeActorHostClient } from "../runtime-broker/actor-host.ts";
import type { wrapLeasedMessage, LeaseToken } from "../runs/session-handoff.ts";
import type {
  applyModelRouting,
  ResolvedModelRegistrationRouting,
  TeammateTaskType,
} from "../models/model-routing.ts";
import type { DispatchAuthorityProjection } from "../models/model-registry.ts";
import type { ModelHealthCoordinator } from "../models/model-circuit-breaker.ts";
import type { TeammatePlacementV1 } from "pi-maestro-fabric-core/v1/placement";
import type { assertValidTeammatePlacement } from "pi-maestro-fabric-core/v1/validation";
import type {
  BackendRegistry,
  ResolvedBackend,
} from "pi-maestro-backend-core/v1/registry";
import type { TeammateModelCapability } from "../models/model-catalog.ts";
import type {
  sharedModelCircuitBreaker,
  ModelCircuitBreaker,
} from "../models/model-circuit-breaker.ts";
import type { MANAGED_WINDOW_ENV, getTeammateChildExtensions } from "../runs/child-extensions.ts";
import type {
  parseTeammateThinkingLevel,
  TeammateThinkingInput,
  TeammateThinkingLevel,
} from "../shared/thinking.ts";
import type {
  isFallbackProviderError,
  ModelHealthFailureScopeClassifier,
} from "../runs/retry.ts";
import type { RunTeammateParams, NormalizedTask } from "../runs/execution-infra.ts";
import type { InfraPorts } from "./lifecycle-contracts.ts";
export interface TaskOutput {
  text: string;
  structured?: unknown;
}
export interface NormalizeTeammateResult {
  tasks: NormalizedTask[];
  isMultiTask: boolean;
  warnings: string[];
  error?: string;
}

export function createAdmissionOwner(ports: InfraPorts & { MAX_DEFAULT_DEPTH: number; resolveMaxAgents: typeof import("../runs/execution-infra.ts").resolveMaxAgents; findStructuredOutputSchemaHazard: typeof import("../runs/execution-infra.ts").findStructuredOutputSchemaHazard }) {
 const { spawn,
  createHash,
  randomUUID,
  fs,
  os,
  path,
  StringDecoder,
  fileURLToPath,
  describeDeclaredValueFailure,
  parseDeclaredJsonResult,
  crossSpawn,
  listAgentSummaries,
  resolveAgent,
  resolvePiAgentDirectory,
  resolveReplyTo,
  wrapLeasedMessage,
  applyModelRouting,
  sharedModelCircuitBreaker,
  MANAGED_WINDOW_ENV,
  getTeammateChildExtensions,
  parseTeammateThinkingLevel,
  isFallbackProviderError,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  clearImmediate,
  MAX_DEFAULT_DEPTH,
  resolveMaxAgents,
  findStructuredOutputSchemaHazard } = ports;
 const assertValidTeammatePlacement: InfraPorts["assertValidTeammatePlacement"] = ports.assertValidTeammatePlacement;

const VAR_PATTERN_SOURCE = "\\{([a-zA-Z_][a-zA-Z0-9_-]*)((?:\\.[a-zA-Z_][a-zA-Z0-9_-]*|\\[\\d+\\])*)\\}";



function extractDependencies(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const deps: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (taskNames.has(name) && !deps.includes(name)) {
      deps.push(name);
    }
  }
  return deps;
}

/**
 * Collect `{name}` references in a template that do NOT match any task name.
 * These are passed through as literal text at resolution time — surfacing
 * them lets callers distinguish intentional literals from misspelled refs.
 */
function collectUnknownRefs(
  template: string | undefined,
  taskNames: Set<string>,
): string[] {
  if (!template) return [];
  const unknown: string[] = [];
  const pattern = new RegExp(VAR_PATTERN_SOURCE, "g");
  let m;
  while ((m = pattern.exec(template)) !== null) {
    const name = m[1];
    if (!taskNames.has(name) && !unknown.includes(name)) {
      unknown.push(name);
    }
  }
  return unknown;
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dist: number[] = new Array(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    let prevDiag = dist[0];
    dist[0] = i;
    for (let j = 1; j < cols; j++) {
      const tmp = dist[j];
      dist[j] = Math.min(
        dist[j] + 1,
        dist[j - 1] + 1,
        prevDiag + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prevDiag = tmp;
    }
  }
  return dist[cols - 1];
}

/**
 * Union of a task's implicit `{name}` references and explicit dependsOn names.
 * Single source of truth for graph edges — used by inferGraphMode, runGraph,
 * and progress snapshots so all three agree on the dependency set.
 */
function taskDependencyNames(
  task: Pick<NormalizedTask, "prompt" | "dependsOn">,
  taskNames: Set<string>,
): string[] {
  const deps = extractDependencies(task.prompt, taskNames);
  for (const name of task.dependsOn ?? []) {
    if (taskNames.has(name) && !deps.includes(name)) deps.push(name);
  }
  return deps;
}

/**
 * Validate task references before dispatch.
 *
 * - dependsOn entries must match an existing task name — strict error
 *   (no literal-text ambiguity exists for an explicit dependency list).
 * - Unknown `{name}` refs close to an existing task name (edit distance)
 *   are treated as misspellings — error, because silently running the task
 *   without the intended dependency is worse than rejecting.
 * - Other unknown `{name}` refs are legitimate literals — warning only.
 *   Skipped entirely when no task has a name (reference intent impossible).
 */
function validateTaskReferences(
  tasks: NormalizedTask[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));

  tasks.forEach((t, i) => {
    const label = t.name ? `tasks[${i}] "${t.name}"` : `tasks[${i}]`;
    for (const name of t.dependsOn ?? []) {
      if (t.name && name === t.name) {
        errors.push(`${label}: dependsOn references itself — a task cannot depend on itself`);
      } else if (!taskNames.has(name)) {
        errors.push(`${label}: dependsOn references unknown task name "${name}"`);
      }
    }
    if (taskNames.size === 0) return;
    // Implicit self-reference: {ownName} in the prompt creates a self-loop
    // that runGraph's hasCycle would reject for multi-task dispatches, but
    // single-task dispatch bypasses runGraph entirely — catch it here.
    if (t.name && extractDependencies(t.prompt, taskNames).includes(t.name)) {
      errors.push(
        `${label}: prompt references its own task name "{${t.name}}" — a task cannot depend on itself`,
      );
    }
    for (const name of collectUnknownRefs(t.prompt, taskNames)) {
      const threshold = name.length <= 3 ? 1 : 2;
      const close = [...taskNames].find(
        (candidate) => candidate !== t.name && editDistance(name, candidate) <= threshold,
      );
      if (close) {
        errors.push(
          `${label}: "{${name}}" looks like a misspelled reference to task "${close}" — fix the reference or rename the task`,
        );
      } else {
        warnings.push(
          `${label}: "{${name}}" does not match any task name and will be passed through as literal text`,
        );
      }
    }
  });

  return { errors, warnings };
}

function resolvePath(obj: unknown, pathStr: string): unknown {
  const parts = pathStr.split(/\.|\[|\]/).filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveVariables(
  template: string,
  outputs: Map<string, TaskOutput>,
  taskNames: Set<string>,
): string {
  return template.replace(
    new RegExp(VAR_PATTERN_SOURCE, "g"),
    (match, name: string, pathSuffix: string) => {
      if (!taskNames.has(name)) return match;
      const output = outputs.get(name);
      if (!output) {
        throw new Error(
          `Task "${name}" completed without publishing a consumable output`,
        );
      }

      if (!pathSuffix) {
        if (output.structured !== undefined) {
          return typeof output.structured === "string"
            ? output.structured
            : JSON.stringify(output.structured);
        }
        return output.text;
      }

      if (output.structured === undefined) {
        throw new Error(
          `Task "${name}" has no structured output for field access "${pathSuffix}"`,
        );
      }
      const value = resolvePath(output.structured, pathSuffix.slice(1));
      if (value === undefined) {
        throw new Error(
          `Field "${pathSuffix}" not found in task "${name}" structured output`,
        );
      }
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  );
}

// ---------------------------------------------------------------------------
// Dependency graph utilities
// ---------------------------------------------------------------------------

function hasCycle(adjList: number[][]): boolean {
  const n = adjList.length;
  const state = new Array<number>(n).fill(0);

  function dfs(node: number): boolean {
    if (state[node] === 1) return true;
    if (state[node] === 2) return false;
    state[node] = 1;
    for (const dep of adjList[node]) {
      if (dfs(dep)) return true;
    }
    state[node] = 2;
    return false;
  }

  for (let i = 0; i < n; i++) {
    if (dfs(i)) return true;
  }
  return false;
}

function inferGraphMode(
  tasks: NormalizedTask[],
): "parallel" | "chain" | "graph" {
  const taskNames = new Set(tasks.filter((t) => t.name).map((t) => t.name!));
  if (taskNames.size === 0) return "parallel";

  let hasDeps = false;
  let allLinear = true;

  for (let i = 0; i < tasks.length; i++) {
    const deps = taskDependencyNames(tasks[i], taskNames);
    if (deps.length > 0) hasDeps = true;
    if (deps.length > 1) allLinear = false;
    if (deps.length === 1 && i > 0 && deps[0] !== tasks[i - 1].name) {
      allLinear = false;
    }
  }

  if (!hasDeps) return "parallel";
  if (allLinear) return "chain";
  return "graph";
}

// ---------------------------------------------------------------------------
// Unified param normalization (shared by tool execute and child proxy paths)

/**
 * Normalize a `todo` binding (single id or ordered array) into a de-duplicated
 * ordered id list. The array order is the priority order (first = highest).
 */
function normalizeTodoBindings(todo: string | string[] | undefined): string[] | undefined {
  if (todo === undefined) return undefined;
  const ids = Array.isArray(todo) ? todo : [todo];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of ids) {
    const id = String(raw).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.length > 0 ? result : undefined;
}

/** Dedupe and trim briefing entries; empty results collapse to undefined. */
function normalizeBriefingEntries(briefing: string[] | undefined): string[] | undefined {
  if (briefing === undefined) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of briefing) {
    const entry = String(raw).trim();
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result.length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------

/** Public task prompt budget, measured after UTF-8 encoding. */
const MAX_TASK_PROMPT_BYTES = 1024 * 1024;

// Allow ordinary multiline text (tab, LF, CR); reject terminal/control input.
const DISALLOWED_TASK_PROMPT_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/** Return an actionable boundary error for a task prompt, if any. */
function taskPromptBoundaryError(prompt: unknown): string | undefined {
  if (typeof prompt !== "string") return "requires a string prompt";
  if (prompt.trim().length === 0) return "requires non-empty text";
  const control = prompt.match(DISALLOWED_TASK_PROMPT_CONTROL)?.[0];
  if (control !== undefined) {
    const codePoint = control.codePointAt(0) ?? 0;
    return `contains unsupported control character U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes > MAX_TASK_PROMPT_BYTES) {
    return `is ${bytes} UTF-8 bytes; maximum is ${MAX_TASK_PROMPT_BYTES}`;
  }
  return undefined;
}



const EXPERT_MODE_LEADER_AGENT = "workflow";
const EXPERT_MODE_LEADER_TASK_TYPE: TeammateTaskType = "planning";
const EXPERT_MODE_LEADER_NAME = "expert-leader";
const EXPERT_MODE_PROMPT_START = "<expert-leader-contract>";
const EXPERT_MODE_PROMPT_END = "</expert-leader-contract>";
const EXPERT_MODE_PREPARED = Symbol("pi-maestro-teammate.expert-mode-prepared");
const EXPERT_MODE_OVERRIDE_ERROR = Symbol("pi-maestro-teammate.expert-mode-override-error");
type ExpertPreparedParams = RunTeammateParams & {
  [EXPERT_MODE_PREPARED]?: true;
  [EXPERT_MODE_OVERRIDE_ERROR]?: string;
};

function buildExpertLeaderPrompt(objective: string): string {
  return `${EXPERT_MODE_PROMPT_START}
You are the Expert Leader. Own decomposition, delegation, evidence review, and synthesis; do not perform substantive investigation or implementation yourself.

Objective:
${objective}

Execution contract:
1. Build the smallest useful DAG. Dispatch only roles required by the objective; put independent work in one call and encode ordering with dependsOn. Use named-output interpolation only when downstream work consumes that output.
2. Use exact agent roles from the available catalog and always set taskType. Do not set model fields; model routing owns provider selection. Never use mode=expert for child dispatches.
3. Leaf agents must use maxNestingDepth: 0. Assign implementation to general-executor when available (fallback: general); keep exploration, analysis, review, and testing read-only unless their assignment explicitly owns writes.
4. Give each overlapping file set exactly one writer. Run independent writers only on disjoint files, and pass concrete scope, acceptance criteria, and focused verification to every implementation task.
5. Prefer foreground dispatch for every result needed by synthesis. Use background only for independent work that does not affect the current result. If a background result must be consumed, call observe exactly once with a bounded wait; never poll observe, teammate-list, or teammate-send for completion.
6. Treat result publication as the dependency release boundary. Do not wait for agent_end after a consumable result is available. When a child returns an agent:// publication reference, read it with resource before synthesis. Do not synthesize while required tasks are unresolved.
7. Require the smallest behavior-relevant verification from each child and reuse valid evidence. Do not schedule broad suites, duplicate review waves, or rerun passing checks without a material invalidator.
8. On child failure, classify it and perform at most one bounded retry or reroute. Never hide, silently skip, or endlessly retry a failed lane.
9. If the objective is Goal-gated, do not claim Goal completion from child self-reports. Return focused workspace evidence and blockers to the root so the canonical Goal verifier can decide fail-closed.
10. Before answering, reconcile child outputs against the objective, resolve contradictions with evidence, and report remaining uncertainty. Return one concise synthesis with outcome, evidence, changed files when any, verification, and blockers.
${EXPERT_MODE_PROMPT_END}`;
}

function expertModeOverrideError(params: RunTeammateParams): string | undefined {
  if (params.mode !== "expert" || !Array.isArray(params.tasks)) return undefined;
  const conflicts: string[] = [];
  if (params.agent !== undefined && params.agent !== EXPERT_MODE_LEADER_AGENT) {
    conflicts.push(`top-level agent must be \"${EXPERT_MODE_LEADER_AGENT}\"`);
  }
  if (params.taskType !== undefined && params.taskType !== EXPERT_MODE_LEADER_TASK_TYPE) {
    conflicts.push(`top-level taskType must be \"${EXPERT_MODE_LEADER_TASK_TYPE}\"`);
  }
  if (params.maxNestingDepth !== undefined && params.maxNestingDepth !== 1) {
    conflicts.push("top-level maxNestingDepth must be 1");
  }
  for (const [index, task] of params.tasks.entries()) {
    if (task.agent !== undefined && task.agent !== EXPERT_MODE_LEADER_AGENT) {
      conflicts.push(`tasks[${index}].agent must be \"${EXPERT_MODE_LEADER_AGENT}\"`);
    }
    if (task.taskType !== undefined && task.taskType !== EXPERT_MODE_LEADER_TASK_TYPE) {
      conflicts.push(`tasks[${index}].taskType must be \"${EXPERT_MODE_LEADER_TASK_TYPE}\"`);
    }
    if (task.maxNestingDepth !== undefined && task.maxNestingDepth !== 1) {
      conflicts.push(`tasks[${index}].maxNestingDepth must be 1`);
    }
  }
  return conflicts.length > 0
    ? `Expert mode owns Leader routing; ${conflicts.join("; ")}. Remove conflicting overrides.`
    : undefined;
}

/**
 * Expand the lightweight expert strategy before model routing. The workflow
 * agent is the Leader; its existing teammate access and nesting budget provide
 * the expert DAG without a second execution engine or persistent mode state.
 */
function prepareTeammateMode(params: RunTeammateParams): RunTeammateParams {
  const prepared = params as ExpertPreparedParams;
  if (params.mode !== "expert" || !Array.isArray(params.tasks) || prepared[EXPERT_MODE_PREPARED]) {
    return params;
  }
  const overrideError = expertModeOverrideError(params);
  if (overrideError) {
    return { ...params, [EXPERT_MODE_OVERRIDE_ERROR]: overrideError } as ExpertPreparedParams;
  }
  return {
    ...params,
    [EXPERT_MODE_PREPARED]: true,
    maxNestingDepth: 1,
    tasks: params.tasks.map((task) => ({
      ...task,
      prompt: buildExpertLeaderPrompt(task.prompt),
      name: task.name ?? EXPERT_MODE_LEADER_NAME,
      description: task.description ?? "Expert Leader",
      agent: EXPERT_MODE_LEADER_AGENT,
      taskType: EXPERT_MODE_LEADER_TASK_TYPE,
      maxNestingDepth: 1,
    })),
  } as ExpertPreparedParams;
}

/** Normalize the tasks-only public contract into executable graph tasks. */
function normalizeTeammateParams(
  params: RunTeammateParams,
): NormalizeTeammateResult {
  const warnings: string[] = [];
  const prepared = params as ExpertPreparedParams;
  const expertOverrideError = prepared[EXPERT_MODE_OVERRIDE_ERROR] ?? expertModeOverrideError(params);
  if (expertOverrideError) {
    return { tasks: [], isMultiTask: false, warnings, error: expertOverrideError };
  }
  params = prepareTeammateMode(params);
  params.background = params.background === true;

  if (!Array.isArray(params.tasks) || params.tasks.length === 0) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: 'Requires a non-empty "tasks" array.',
    };
  }

  if ((params.fast !== undefined && typeof params.fast !== "boolean")
    || params.tasks.some((task) => task.fast !== undefined && typeof task.fast !== "boolean")) {
    return { tasks: [], isMultiTask: false, warnings, error: "Fast must be a boolean when supplied." };
  }

  if (params.mode === "expert" && params.tasks.length !== 1) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: 'Expert mode requires exactly one objective task for the workflow Leader.',
    };
  }

  if (
    params.concurrencyWaitMs !== undefined
    && (!Number.isInteger(params.concurrencyWaitMs) || params.concurrencyWaitMs < 1)
  ) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: `concurrencyWaitMs must be a positive integer (got ${params.concurrencyWaitMs}).`,
    };
  }

  if (
    params.maxNestingDepth !== undefined
    && (!Number.isInteger(params.maxNestingDepth)
      || params.maxNestingDepth < 0
      || params.maxNestingDepth > MAX_DEFAULT_DEPTH)
  ) {
    return {
      tasks: [],
      isMultiTask: false,
      warnings,
      error: `maxNestingDepth must be an integer between 0 and ${MAX_DEFAULT_DEPTH} `
        + `(got ${params.maxNestingDepth}); 0 forbids nested teammate calls.`,
    };
  }

  const requestedTodoIds=new Set<string>();
  for(const task of params.tasks){for(const raw of task.todo===undefined?[]:Array.isArray(task.todo)?task.todo:[task.todo]){
    const id=String(raw).trim();
    if(!id||requestedTodoIds.has(id))return {tasks:[],isMultiTask:false,warnings,error:"Duplicate or empty Todo dispatch ID"};
    requestedTodoIds.add(id);
  }}
  for (const [index, task] of params.tasks.entries()) {
    if (params.mode === "expert" && (task.maxNestingDepth ?? params.maxNestingDepth ?? 0) < 1) {
      return {
        tasks: [],
        isMultiTask: false,
        warnings,
        error: "Expert mode requires maxNestingDepth >= 1 so the workflow Leader can dispatch experts.",
      };
    }
    if (task.background !== undefined) {
      warnings.push(
        `tasks[${index}]${task.name ? ` "${task.name}"` : ""} "background" is a dispatch-level setting; per-task background is not supported and is ignored. Pass background at the top level instead.`,
      );
    }
    if (
      task.maxNestingDepth !== undefined
      && (!Number.isInteger(task.maxNestingDepth)
        || task.maxNestingDepth < 0
        || task.maxNestingDepth > MAX_DEFAULT_DEPTH)
    ) {
      return {
        tasks: [],
        isMultiTask: false,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} maxNestingDepth must be an integer between 0 and ${MAX_DEFAULT_DEPTH} `
          + `(got ${task.maxNestingDepth}); 0 forbids nested teammate calls.`,
      };
    }
    const placement = task.placement ?? params.placement;
    if (placement !== undefined) {
      const label = `tasks[${index}]${task.name ? ` "${task.name}"` : ""}`;
      try {
        // Checked at validation so an expired or malformed placement fails here
        // rather than after a route has already been prepared.
        assertValidTeammatePlacement(placement, Date.now());
      } catch (error) {
        return {
          tasks: [],
          isMultiTask: false,
          warnings,
          error: `${label} has an invalid Fabric placement: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if ((normalizeTodoBindings(task.todo) ?? []).length > 0) {
        return {
          tasks: [],
          isMultiTask: false,
          warnings,
          error: `${label} binds Todo ids together with a Fabric placement. A placed Agent Endpoint runs in its own workspace and cannot serve this host's Todo queue, so the bound items would stall at in_progress; drop "todo" and dispatch without it.`,
        };
      }
    }
  }

  const normalized: NormalizedTask[] = params.tasks.map((task) => ({
    agent: task.agent ?? params.agent ?? "general",
    prompt: task.prompt,
    description: task.description,
    taskType: task.taskType ?? params.taskType,
    name: task.name,
    backend: task.backend ?? params.backend,
    dependsOn: task.dependsOn,
    context: task.context ?? params.context,
    model: task.model ?? params.model,
    modelSelection: task.modelSelection,
    fallbackModels: task.fallbackModels ?? params.fallbackModels,
    thinking: parseTeammateThinkingLevel(task.thinking ?? params.thinking),
    fast: task.fast ?? params.fast,
    cwd: task.cwd ?? params.cwd,
    outputSchema: task.outputSchema ?? params.outputSchema,
    timeoutMs: task.timeoutMs ?? params.timeoutMs,
    maxNestingDepth: task.maxNestingDepth ?? params.maxNestingDepth,
    todos: normalizeTodoBindings(task.todo),
    briefing: normalizeBriefingEntries(task.briefing),
    placement: task.placement ?? params.placement,
  }));
  const isMultiTask = normalized.length > 1;

  for (const [index, task] of normalized.entries()) {
    const hasNoPrompt = typeof task.prompt !== "string" || task.prompt.trim().length === 0;
    const strayPrompt =
      task.outputSchema !== undefined
      && typeof task.outputSchema === "object"
      && task.outputSchema !== null
      && typeof task.outputSchema.prompt === "string";
    if (hasNoPrompt && strayPrompt) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} has no "prompt" — the prompt text was placed inside "outputSchema". Move "prompt" to the task level (a sibling of outputSchema); outputSchema holds only the JSON Schema.`,
      };
    }
    if (hasNoPrompt) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} requires a non-empty "prompt".`,
      };
    }
    const promptBoundaryError = taskPromptBoundaryError(task.prompt);
    if (promptBoundaryError) {
      return {
        tasks: normalized,
        isMultiTask,
        warnings,
        error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} prompt ${promptBoundaryError}.`,
      };
    }
    if (strayPrompt) {
      // Task-level prompt already exists: the stray string is not a JSON Schema
      // keyword and would otherwise leak into the child's schema file. Salvage
      // it instead of rejecting — the dispatch intent is unambiguous.
      const cleaned = { ...task.outputSchema! };
      delete cleaned.prompt;
      normalized[index] = { ...task, outputSchema: cleaned };
      warnings.push(
        `tasks[${index}]${task.name ? ` "${task.name}"` : ""}: removed a task-text "prompt" key from "outputSchema" (not a JSON Schema keyword). Keep the task text at the task-level "prompt".`,
      );
    }

    const outputSchema = normalized[index].outputSchema;
    if (outputSchema) {
      const schemaHazard = findStructuredOutputSchemaHazard(outputSchema);
      if (schemaHazard) {
        return {
          tasks: normalized,
          isMultiTask,
          warnings,
          error: `tasks[${index}]${task.name ? ` "${task.name}"` : ""} has an invalid outputSchema: ${schemaHazard}`,
        };
      }
    }
  }

  const maxAgents = resolveMaxAgents(params.maxAgents);
  if (normalized.length > maxAgents) {
    return {
      tasks: normalized,
      isMultiTask,
      warnings,
      error: `Too many tasks: ${normalized.length} exceeds the maximum of ${maxAgents}. Split into smaller batches or raise the limit via maxAgents / PI_TEAMMATE_MAX_AGENTS.`,
    };
  }

  const refCheck = validateTaskReferences(normalized);
  warnings.push(...refCheck.warnings);
  if (refCheck.errors.length > 0) {
    return {
      tasks: normalized,
      isMultiTask,
      warnings,
      error: refCheck.errors.join("\n"),
    };
  }

  return { tasks: normalized, isMultiTask, warnings };
}


 return { VAR_PATTERN_SOURCE,
  extractDependencies,
  collectUnknownRefs,
  editDistance,
  taskDependencyNames,
  validateTaskReferences,
  resolvePath,
  resolveVariables,
  hasCycle,
  inferGraphMode,
  normalizeTodoBindings,
  normalizeBriefingEntries,
  MAX_TASK_PROMPT_BYTES,
  taskPromptBoundaryError,
  EXPERT_MODE_LEADER_AGENT,
  EXPERT_MODE_LEADER_TASK_TYPE,
  EXPERT_MODE_LEADER_NAME,
  EXPERT_MODE_PROMPT_START,
  EXPERT_MODE_PROMPT_END,
  buildExpertLeaderPrompt,
  prepareTeammateMode,
  normalizeTeammateParams };
}
