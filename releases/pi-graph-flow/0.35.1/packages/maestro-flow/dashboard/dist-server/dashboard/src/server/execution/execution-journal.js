// ---------------------------------------------------------------------------
// ExecutionJournal — append-only JSONL event log for crash recovery
// ---------------------------------------------------------------------------
import { appendFile, readFile, rename, mkdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
export class ExecutionJournal {
    journalPath;
    maxSizeBytes;
    constructor(workflowRoot, maxSizeBytes = 10 * 1024 * 1024) {
        this.journalPath = join(workflowRoot, 'execution', 'journal.jsonl');
        this.maxSizeBytes = maxSizeBytes;
    }
    /** Append a single event atomically (single-line JSON + appendFile) */
    async append(event) {
        await mkdir(dirname(this.journalPath), { recursive: true });
        const record = { ...event, timestamp: event.timestamp || new Date().toISOString() };
        const line = JSON.stringify(record) + '\n';
        await appendFile(this.journalPath, line, 'utf-8');
    }
    /** Read all events from the journal */
    async readAll() {
        let raw;
        try {
            raw = await readFile(this.journalPath, 'utf-8');
        }
        catch {
            return [];
        }
        const events = [];
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                events.push(JSON.parse(trimmed));
            }
            catch {
                // Skip malformed lines — journal must be resilient to partial writes
            }
        }
        return events;
    }
    /** Get events for a specific issue */
    async getEventsForIssue(issueId) {
        const all = await this.readAll();
        return all.filter((e) => e.issueId === issueId);
    }
    /** Analyze journal and determine recovery actions for interrupted executions */
    async recover() {
        const events = await this.readAll();
        const actions = [];
        // Group by issueId
        const byIssue = new Map();
        for (const event of events) {
            const list = byIssue.get(event.issueId) || [];
            list.push(event);
            byIssue.set(event.issueId, list);
        }
        for (const [issueId, issueEvents] of byIssue) {
            const sorted = issueEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            const last = sorted[sorted.length - 1];
            if (last.type === 'issue:dispatched') {
                // Dispatched but no completion/failure — server crashed during execution
                actions.push({
                    issueId,
                    action: 'retry',
                    reason: 'Dispatched but no completion event — server crashed',
                });
            }
            else if (last.type === 'wave:started' || last.type === 'wave:task_completed') {
                // Wave in progress — find completed tasks for resume
                const completedTaskIds = sorted
                    .filter((e) => e.type === 'wave:task_completed')
                    .map((e) => e.taskId);
                actions.push({
                    issueId,
                    action: 'resume-wave',
                    reason: `Wave interrupted with ${completedTaskIds.length} completed tasks`,
                    completedTaskIds,
                });
            }
            // issue:completed or issue:failed — terminal states, no action needed
        }
        return actions;
    }
    /** Rotate journal when it exceeds maxSizeBytes */
    async rotate() {
        try {
            const info = await stat(this.journalPath);
            if (info.size > this.maxSizeBytes) {
                const archivePath = this.journalPath.replace('.jsonl', `-${Date.now()}.jsonl`);
                await rename(this.journalPath, archivePath);
            }
        }
        catch {
            // File doesn't exist yet — nothing to rotate
        }
    }
}
//# sourceMappingURL=execution-journal.js.map