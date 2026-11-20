import type { AgentType } from './agent-types.js';
import type { IssueExecution, PromptMode } from './execution-types.js';
/** Issue classification */
export type IssueType = 'bug' | 'feature' | 'improvement' | 'task';
/** Issue priority levels */
export type IssuePriority = 'low' | 'medium' | 'high' | 'urgent';
/** Issue lifecycle status */
export type IssueStatus = 'open' | 'registered' | 'in_progress' | 'resolved' | 'closed' | 'deferred';
/** A single step in an issue solution plan */
export interface SolutionStep {
    description: string;
    target?: string;
    verification?: string;
}
/** Pre-planned solution attached to an issue */
export interface IssueSolution {
    steps: SolutionStep[];
    context?: string;
    promptTemplate?: string;
    chain?: string;
    chainMode?: 'full' | 'plan-execute' | 'direct';
    planned_at?: string;
    planned_by?: string;
}
/** Structured root cause analysis record attached to an issue */
export interface IssueAnalysis {
    root_cause: string;
    impact: string;
    related_files: string[];
    confidence: number;
    suggested_approach: string;
    analyzed_at: string;
    analyzed_by: string;
}
/** Issue resolution path */
export type IssuePath = 'standalone' | 'workflow';
/** Full Issue record (stored in JSONL) */
export interface Issue {
    id: string;
    title: string;
    description: string;
    type: IssueType;
    priority: IssuePriority;
    status: IssueStatus;
    executor?: AgentType;
    promptMode?: PromptMode;
    /** @deprecated Use task_refs + task_plan_dir instead. Retained for backward compat with legacy data. */
    solution?: IssueSolution;
    analysis?: IssueAnalysis;
    execution?: IssueExecution;
    /** Associated TASK IDs (e.g. ["TASK-001", "TASK-003"]) — written by maestro-plan --gaps */
    task_refs?: string[];
    /** Relative path to .task/ directory containing the TASK JSON files */
    task_plan_dir?: string;
    supplements?: IssueSupplement[];
    path?: IssuePath;
    phase_id?: number;
    source_entry_id?: string;
    source_process_id?: string;
    created_at: string;
    updated_at: string;
}
/** Request body for creating a new issue */
export interface CreateIssueRequest {
    title: string;
    description: string;
    type?: IssueType;
    priority?: IssuePriority;
    executor?: AgentType;
    source_entry_id?: string;
    source_process_id?: string;
}
/** Request body for updating an existing issue */
export interface UpdateIssueRequest {
    title?: string;
    description?: string;
    type?: IssueType;
    priority?: IssuePriority;
    status?: IssueStatus;
    executor?: AgentType;
    promptMode?: PromptMode;
}
export declare const VALID_ISSUE_TYPES: ReadonlySet<string>;
export declare const VALID_ISSUE_PRIORITIES: ReadonlySet<string>;
export declare const VALID_ISSUE_STATUSES: ReadonlySet<string>;
/** Lifecycle stage for a supplement entry */
export type SupplementStage = 'post_creation' | 'analysis' | 'planning' | 'pre_execution' | 'execution' | 'resolution' | 'general';
/** A user-added context supplement attached to an issue */
export interface IssueSupplement {
    content: string;
    stage: SupplementStage;
    author: string;
    created_at: string;
}
/** Derive the current supplement stage from an issue's status */
export declare function deriveSupplementStage(issue: Issue): SupplementStage;
