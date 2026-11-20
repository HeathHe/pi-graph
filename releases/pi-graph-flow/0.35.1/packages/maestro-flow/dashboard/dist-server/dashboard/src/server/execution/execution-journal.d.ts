import type { JournalEvent, RecoveryAction } from '../../shared/journal-types.js';
export declare class ExecutionJournal {
    private readonly journalPath;
    private readonly maxSizeBytes;
    constructor(workflowRoot: string, maxSizeBytes?: number);
    /** Append a single event atomically (single-line JSON + appendFile) */
    append(event: JournalEvent): Promise<void>;
    /** Read all events from the journal */
    readAll(): Promise<JournalEvent[]>;
    /** Get events for a specific issue */
    getEventsForIssue(issueId: string): Promise<JournalEvent[]>;
    /** Analyze journal and determine recovery actions for interrupted executions */
    recover(): Promise<RecoveryAction[]>;
    /** Rotate journal when it exceeds maxSizeBytes */
    rotate(): Promise<void>;
}
