import type { ExpandedRequirement, ExpansionDepth, RequirementProgressPayload } from '../../shared/requirement-types.js';
import type { WorkflowCoordinator } from '../coordinator/workflow-coordinator.js';
export type RequirementProgressListener = (payload: RequirementProgressPayload) => void;
export type ExpansionMethod = 'sdk' | 'cli';
export declare class RequirementExpander {
    private readonly store;
    private readonly coordinateRunner;
    private readonly issueJsonlPath;
    private readonly requirementDir;
    private readonly progressListeners;
    constructor(coordinateRunner: WorkflowCoordinator, issueJsonlPath: string, requirementDir?: string);
    /** Subscribe to progress events (used by WS handler to forward to clients) */
    onProgress(listener: RequirementProgressListener): void;
    /** Unsubscribe from progress events */
    offProgress(listener: RequirementProgressListener): void;
    /** Get an expanded requirement by ID */
    get(id: string): ExpandedRequirement | undefined;
    /** Get all expanded requirements */
    getAll(): ExpandedRequirement[];
    /** Expand user text into a structured requirement checklist */
    expand(text: string, depth?: ExpansionDepth, method?: ExpansionMethod, previousRequirementId?: string): Promise<ExpandedRequirement>;
    /** Refine an existing expansion with user feedback */
    refine(id: string, feedback: string): Promise<ExpandedRequirement>;
    /** Convert each checklist item to an Issue and append to issues.jsonl */
    commitAsIssues(id: string): Promise<string[]>;
    /** Build intent from requirement and start a WorkflowCoordinator session */
    commitAsCoordinate(id: string): Promise<string>;
    /** Run an Agent SDK query with structured output and retry on parse failure */
    private runExpansionQuery;
    /** Map status to stage name and progress percentage */
    private static readonly STATUS_PROGRESS;
    /** Emit a progress event to all registered listeners */
    private emitProgress;
    /** Persist an ExpandedRequirement to a JSON file */
    private persistRequirement;
    /** Load all persisted requirements from the requirement directory */
    private loadPersistedRequirements;
}
