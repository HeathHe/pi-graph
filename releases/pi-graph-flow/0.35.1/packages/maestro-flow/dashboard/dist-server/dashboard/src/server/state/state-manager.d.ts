import type { BoardState, PhaseCard, TaskCard, ProjectState } from '../../shared/types.js';
import type { DashboardEventBus } from './event-bus.js';
export declare class StateManager {
    private workflowRoot;
    private readonly eventBus;
    private board;
    /** Cache: phase number → directory path for O(1) lookups */
    private phaseDirCache;
    private isSwitching;
    constructor(workflowRoot: string, eventBus: DashboardEventBus);
    /** Return current workspace project root (parent of .workflow/) */
    getWorkspaceRoot(): string;
    /** Return current .workflow/ directory path (updates on workspace switch) */
    getWorkflowRoot(): string;
    /** Return current board state snapshot */
    getBoard(): BoardState;
    /** Return project state */
    getProject(): ProjectState;
    /** Return a specific phase by number, or undefined */
    getPhase(n: number): PhaseCard | undefined;
    /** Return tasks for a given phase number */
    getTasks(phaseNum: number): Promise<TaskCard[]>;
    buildInitialState(): Promise<BoardState>;
    get switching(): boolean;
    resetForNewWorkspace(newRoot: string): Promise<void>;
    applyFileChange(filePath: string): Promise<void>;
    private upsertPhase;
    private upsertScratch;
    private readAllPhases;
    private readAllScratch;
}
