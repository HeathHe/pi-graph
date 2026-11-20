// ---------------------------------------------------------------------------
// TaskSchedulerService -- manages scheduled tasks with node-cron, CRUD,
// JSON persistence, and built-in task type handlers
// ---------------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import cron from 'node-cron';
// ---------------------------------------------------------------------------
// TaskSchedulerService
// ---------------------------------------------------------------------------
export class TaskSchedulerService {
    eventBus;
    workflowRoot;
    executionScheduler;
    selfLearningService;
    schedulesPath;
    tasks = new Map();
    jobs = new Map();
    constructor(eventBus, workflowRoot, executionScheduler, selfLearningService) {
        this.eventBus = eventBus;
        this.workflowRoot = workflowRoot;
        this.executionScheduler = executionScheduler;
        this.selfLearningService = selfLearningService;
        this.schedulesPath = join(workflowRoot, 'schedules.json');
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    /** Load persisted schedules and register cron jobs for enabled tasks */
    async start() {
        await this.loadSchedules();
        for (const task of this.tasks.values()) {
            if (task.enabled) {
                this.registerCronJob(task);
            }
        }
        console.log(`[TaskScheduler] Started with ${this.tasks.size} task(s), ${this.jobs.size} active job(s)`);
    }
    /** Destroy all cron jobs cleanly */
    stop() {
        for (const [id, job] of this.jobs) {
            job.stop();
            this.jobs.delete(id);
        }
        console.log('[TaskScheduler] Stopped, all cron jobs destroyed');
    }
    // -------------------------------------------------------------------------
    // CRUD
    // -------------------------------------------------------------------------
    /** Create a new scheduled task */
    async createTask(input) {
        if (!cron.validate(input.cronExpression)) {
            throw new Error(`Invalid cron expression: ${input.cronExpression}`);
        }
        const task = {
            ...input,
            id: randomUUID(),
            lastRun: null,
            nextRun: null,
            history: [],
        };
        this.tasks.set(task.id, task);
        if (task.enabled) {
            this.registerCronJob(task);
        }
        await this.persistSchedules();
        this.emitScheduleUpdate();
        return task;
    }
    /** Get a single task by id */
    getTask(id) {
        return this.tasks.get(id);
    }
    /** List all scheduled tasks */
    listTasks() {
        return Array.from(this.tasks.values());
    }
    /** Update an existing scheduled task */
    async updateTask(id, updates) {
        const task = this.tasks.get(id);
        if (!task) {
            throw new Error(`Scheduled task not found: ${id}`);
        }
        if (updates.cronExpression !== undefined && !cron.validate(updates.cronExpression)) {
            throw new Error(`Invalid cron expression: ${updates.cronExpression}`);
        }
        // Apply only known mutable fields
        if (updates.name !== undefined)
            task.name = updates.name;
        if (updates.cronExpression !== undefined)
            task.cronExpression = updates.cronExpression;
        if (updates.taskType !== undefined)
            task.taskType = updates.taskType;
        if (updates.config !== undefined)
            task.config = updates.config;
        if (updates.enabled !== undefined)
            task.enabled = updates.enabled;
        if (updates.lastRun !== undefined)
            task.lastRun = updates.lastRun;
        if (updates.nextRun !== undefined)
            task.nextRun = updates.nextRun;
        // Re-register cron job if expression or enabled state changed
        this.unregisterCronJob(id);
        if (task.enabled) {
            this.registerCronJob(task);
        }
        await this.persistSchedules();
        this.emitScheduleUpdate();
        return task;
    }
    /** Delete a scheduled task */
    async deleteTask(id) {
        if (!this.tasks.has(id)) {
            throw new Error(`Scheduled task not found: ${id}`);
        }
        this.unregisterCronJob(id);
        this.tasks.delete(id);
        await this.persistSchedules();
        this.emitScheduleUpdate();
    }
    /** Trigger manual execution of a scheduled task */
    async runTask(id) {
        const task = this.tasks.get(id);
        if (!task) {
            throw new Error(`Scheduled task not found: ${id}`);
        }
        return this.executeTask(task);
    }
    // -------------------------------------------------------------------------
    // Private: Cron job management
    // -------------------------------------------------------------------------
    registerCronJob(task) {
        // Avoid duplicates
        this.unregisterCronJob(task.id);
        const job = cron.schedule(task.cronExpression, () => {
            void this.onCronFire(task.id);
        });
        this.jobs.set(task.id, job);
    }
    unregisterCronJob(id) {
        const existing = this.jobs.get(id);
        if (existing) {
            existing.stop();
            this.jobs.delete(id);
        }
    }
    async onCronFire(taskId) {
        const task = this.tasks.get(taskId);
        if (!task || !task.enabled)
            return;
        this.eventBus.emit('supervisor:schedule_triggered', {
            taskId: task.id,
            taskName: task.name,
            taskType: task.taskType,
        });
        await this.executeTask(task);
    }
    // -------------------------------------------------------------------------
    // Private: Task execution
    // -------------------------------------------------------------------------
    async executeTask(task) {
        const startTime = Date.now();
        let status = 'success';
        let result;
        try {
            result = await this.runTaskHandler(task.taskType, task.config);
        }
        catch (err) {
            status = 'failed';
            result = err instanceof Error ? err.message : String(err);
        }
        const duration = Date.now() - startTime;
        const entry = {
            timestamp: new Date().toISOString(),
            status,
            duration,
            result,
        };
        // Update task state
        task.lastRun = entry.timestamp;
        task.history.push(entry);
        // Keep history bounded (last 50 entries)
        if (task.history.length > 50) {
            task.history = task.history.slice(-50);
        }
        await this.persistSchedules();
        this.emitScheduleUpdate();
        return entry;
    }
    // -------------------------------------------------------------------------
    // Private: Built-in task type handlers
    // -------------------------------------------------------------------------
    async runTaskHandler(taskType, config) {
        switch (taskType) {
            case 'auto-dispatch':
                return this.handleAutoDispatch();
            case 'cleanup':
                return this.handleCleanup(config);
            case 'report':
                return this.handleReport(config);
            case 'health-check':
                return this.handleHealthCheck();
            case 'learning-analysis':
                return this.handleLearningAnalysis();
            case 'custom':
                return `Custom task executed (config: ${JSON.stringify(config)})`;
            default:
                throw new Error(`Unknown task type: ${taskType}`);
        }
    }
    /** auto-dispatch: trigger the execution scheduler tick */
    handleAutoDispatch() {
        if (!this.executionScheduler) {
            return 'Skipped: ExecutionScheduler not available';
        }
        const status = this.executionScheduler.getStatus();
        if (status.isCommanderActive) {
            return 'Skipped: Commander is managing dispatch';
        }
        if (!status.enabled) {
            this.executionScheduler.enableAutoDispatch();
            return 'Auto-dispatch enabled';
        }
        return 'Auto-dispatch already active';
    }
    /** cleanup: prune old journal entries beyond retention period */
    async handleCleanup(config) {
        const retentionDays = typeof config['retentionDays'] === 'number'
            ? config['retentionDays']
            : 30;
        const journalPath = join(this.workflowRoot, 'execution', 'journal.jsonl');
        let raw;
        try {
            raw = await readFile(journalPath, 'utf-8');
        }
        catch {
            return 'No journal file to clean';
        }
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const cutoffMs = cutoff.getTime();
        const lines = raw.split('\n');
        const kept = [];
        let pruned = 0;
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                const entry = JSON.parse(trimmed);
                if (entry.timestamp && new Date(entry.timestamp).getTime() < cutoffMs) {
                    pruned++;
                    continue;
                }
            }
            catch {
                // Keep malformed lines
            }
            kept.push(trimmed);
        }
        if (pruned > 0) {
            await mkdir(dirname(journalPath), { recursive: true });
            await writeFile(journalPath, kept.join('\n') + '\n', 'utf-8');
        }
        return `Cleanup complete: pruned ${pruned} entries older than ${retentionDays} days`;
    }
    /** report: write execution stats summary */
    async handleReport(config) {
        const reportDir = join(this.workflowRoot, 'reports');
        await mkdir(reportDir, { recursive: true });
        const stats = {
            generatedAt: new Date().toISOString(),
            totalScheduledTasks: this.tasks.size,
            enabledTasks: Array.from(this.tasks.values()).filter((t) => t.enabled).length,
            activeJobs: this.jobs.size,
        };
        if (this.executionScheduler) {
            stats['executionScheduler'] = this.executionScheduler.getStatus();
        }
        const filename = `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        const reportPath = join(reportDir, filename);
        await writeFile(reportPath, JSON.stringify(stats, null, 2), 'utf-8');
        return `Report written to ${reportPath}`;
    }
    /** health-check: verify agents and scheduler availability */
    handleHealthCheck() {
        const issues = [];
        if (!this.executionScheduler) {
            issues.push('ExecutionScheduler not available');
        }
        else {
            const status = this.executionScheduler.getStatus();
            if (!status.enabled) {
                issues.push('ExecutionScheduler is disabled');
            }
        }
        if (!this.selfLearningService) {
            issues.push('SelfLearningService not available');
        }
        if (issues.length === 0) {
            return 'All systems healthy';
        }
        return `Health issues: ${issues.join('; ')}`;
    }
    /** learning-analysis: trigger SelfLearningService analysis */
    async handleLearningAnalysis() {
        if (!this.selfLearningService) {
            return 'Skipped: SelfLearningService not available';
        }
        const stats = await this.selfLearningService.analyze();
        return `Learning analysis complete: ${JSON.stringify(stats)}`;
    }
    // -------------------------------------------------------------------------
    // Private: JSON persistence
    // -------------------------------------------------------------------------
    async loadSchedules() {
        try {
            const raw = await readFile(this.schedulesPath, 'utf-8');
            const data = JSON.parse(raw);
            this.tasks.clear();
            for (const task of data) {
                this.tasks.set(task.id, task);
            }
        }
        catch {
            // File missing or unreadable -- start with empty state
            this.tasks.clear();
        }
    }
    async persistSchedules() {
        await mkdir(dirname(this.schedulesPath), { recursive: true });
        const data = Array.from(this.tasks.values());
        await writeFile(this.schedulesPath, JSON.stringify(data, null, 2), 'utf-8');
    }
    // -------------------------------------------------------------------------
    // Private: Event emission
    // -------------------------------------------------------------------------
    emitScheduleUpdate() {
        this.eventBus.emit('supervisor:schedule_update', {
            tasks: this.listTasks(),
        });
    }
}
//# sourceMappingURL=task-scheduler-service.js.map