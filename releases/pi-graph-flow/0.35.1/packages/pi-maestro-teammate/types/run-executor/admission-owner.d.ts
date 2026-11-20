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
export declare function createAdmissionOwner(ports: InfraPorts & {
    MAX_DEFAULT_DEPTH: number;
    resolveMaxAgents: typeof import("../runs/execution-infra.ts").resolveMaxAgents;
    findStructuredOutputSchemaHazard: typeof import("../runs/execution-infra.ts").findStructuredOutputSchemaHazard;
}): {
    VAR_PATTERN_SOURCE: string;
    extractDependencies: (template: string | undefined, taskNames: Set<string>) => string[];
    collectUnknownRefs: (template: string | undefined, taskNames: Set<string>) => string[];
    editDistance: (a: string, b: string) => number;
    taskDependencyNames: (task: Pick<NormalizedTask, "prompt" | "dependsOn">, taskNames: Set<string>) => string[];
    validateTaskReferences: (tasks: NormalizedTask[]) => {
        errors: string[];
        warnings: string[];
    };
    resolvePath: (obj: unknown, pathStr: string) => unknown;
    resolveVariables: (template: string, outputs: Map<string, TaskOutput>, taskNames: Set<string>) => string;
    hasCycle: (adjList: number[][]) => boolean;
    inferGraphMode: (tasks: NormalizedTask[]) => "parallel" | "chain" | "graph";
    normalizeTodoBindings: (todo: string | string[] | undefined) => string[] | undefined;
    normalizeBriefingEntries: (briefing: string[] | undefined) => string[] | undefined;
    MAX_TASK_PROMPT_BYTES: number;
    taskPromptBoundaryError: (prompt: unknown) => string | undefined;
    EXPERT_MODE_LEADER_AGENT: string;
    EXPERT_MODE_LEADER_TASK_TYPE: string;
    EXPERT_MODE_LEADER_NAME: string;
    EXPERT_MODE_PROMPT_START: string;
    EXPERT_MODE_PROMPT_END: string;
    buildExpertLeaderPrompt: (objective: string) => string;
    prepareTeammateMode: (params: RunTeammateParams) => RunTeammateParams;
    normalizeTeammateParams: (params: RunTeammateParams) => NormalizeTeammateResult;
};
