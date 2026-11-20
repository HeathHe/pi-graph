import type { DashboardEventBus } from '../state/event-bus.js';
export interface TimelineEntry {
    timestamp: string;
    source: 'commander' | 'coordinator' | 'execution';
    event: string;
    payload: unknown;
}
export declare class ObservabilityService {
    private readonly eventBus;
    private readonly workflowRoot;
    private readonly timelinePath;
    private readonly listener;
    private initPromise;
    constructor(eventBus: DashboardEventBus, workflowRoot: string);
    private ensureDir;
    private handleEvent;
    private classifySource;
    destroy(): void;
}
