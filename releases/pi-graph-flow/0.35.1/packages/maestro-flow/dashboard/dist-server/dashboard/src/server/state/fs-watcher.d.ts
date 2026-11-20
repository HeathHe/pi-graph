import type { StateManager } from './state-manager.js';
import type { DashboardEventBus } from './event-bus.js';
export declare class FSWatcher {
    private readonly workflowRoot;
    private readonly stateManager;
    private readonly eventBus;
    private readonly debounceMs;
    private watcher;
    private rebuildTimer;
    /** Per-file debounce timers keyed by absolute path */
    private debounceTimers;
    constructor(workflowRoot: string, stateManager: StateManager, eventBus: DashboardEventBus, debounceMs?: number);
    /** Start watching .workflow/ for relevant file changes */
    start(): void;
    /** Stop watching and clean up */
    stop(): Promise<void>;
    private handleChange;
    private scheduleFullRebuild;
    /** Parse a maestro session file and emit WS push event */
    private emitMaestroSessionUpdate;
}
