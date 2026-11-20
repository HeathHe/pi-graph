/** A single subtask decomposed from an issue */
export interface WaveTask {
    id: string;
    title: string;
    description: string;
    /** IDs of tasks this depends on (must complete before this runs) */
    deps: string[];
    /** IDs of tasks whose results should be injected as context */
    contextFrom: string[];
    /** Computed wave number (0-based), set by topological sort */
    wave: number;
    /** Current execution status */
    status: 'pending' | 'running' | 'completed' | 'failed';
    /** Result summary after completion */
    findings?: string;
    /** Files modified by this task */
    filesModified?: string[];
    /** Error message if failed */
    error?: string;
}
/** Wave execution session state */
export interface WaveSession {
    issueId: string;
    processId: string;
    status: 'decomposing' | 'executing' | 'completed' | 'failed';
    tasks: WaveTask[];
    totalWaves: number;
    currentWave: number;
    startedAt: string;
    completedAt?: string;
}
/** Structured output from the decomposition Agent SDK query */
export interface DecompositionResult {
    tasks: Array<{
        id: string;
        title: string;
        description: string;
        deps: string[];
        contextFrom: string[];
    }>;
}
