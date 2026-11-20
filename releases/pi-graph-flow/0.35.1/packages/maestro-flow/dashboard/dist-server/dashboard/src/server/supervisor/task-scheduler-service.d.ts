import type { DashboardEventBus } from '../state/event-bus.js';
import type { ScheduledTask, TaskRunHistory } from '../../shared/schedule-types.js';
/** Minimal interface for ExecutionScheduler dependency */
interface MinimalExecutionScheduler {
    enableAutoDispatch(): void;
    disableAutoDispatch(): void;
    getStatus(): {
        enabled: boolean;
        isCommanderActive: boolean;
    };
}
/** Minimal interface for SelfLearningService dependency */
interface MinimalSelfLearningService {
    analyze(): Promise<unknown>;
}
export declare class TaskSchedulerService {
    private readonly eventBus;
    private readonly workflowRoot;
    private readonly executionScheduler?;
    private readonly selfLearningService?;
    private readonly schedulesPath;
    private tasks;
    private jobs;
    constructor(eventBus: DashboardEventBus, workflowRoot: string, executionScheduler?: MinimalExecutionScheduler | undefined, selfLearningService?: MinimalSelfLearningService | undefined);
    /** Load persisted schedules and register cron jobs for enabled tasks */
    start(): Promise<void>;
    /** Destroy all cron jobs cleanly */
    stop(): void;
    /** Create a new scheduled task */
    createTask(input: Omit<ScheduledTask, 'id' | 'lastRun' | 'nextRun' | 'history'>): Promise<ScheduledTask>;
    /** Get a single task by id */
    getTask(id: string): ScheduledTask | undefined;
    /** List all scheduled tasks */
    listTasks(): ScheduledTask[];
    /** Update an existing scheduled task */
    updateTask(id: string, updates: Partial<Omit<ScheduledTask, 'id' | 'history'>>): Promise<ScheduledTask>;
    /** Delete a scheduled task */
    deleteTask(id: string): Promise<void>;
    /** Trigger manual execution of a scheduled task */
    runTask(id: string): Promise<TaskRunHistory>;
    private registerCronJob;
    private unregisterCronJob;
    private onCronFire;
    private executeTask;
    private runTaskHandler;
    /** auto-dispatch: trigger the execution scheduler tick */
    private handleAutoDispatch;
    /** cleanup: prune old journal entries beyond retention period */
    private handleCleanup;
    /** report: write execution stats summary */
    private handleReport;
    /** health-check: verify agents and scheduler availability */
    private handleHealthCheck;
    /** learning-analysis: trigger SelfLearningService analysis */
    private handleLearningAnalysis;
    private loadSchedules;
    private persistSchedules;
    private emitScheduleUpdate;
}
export {};
