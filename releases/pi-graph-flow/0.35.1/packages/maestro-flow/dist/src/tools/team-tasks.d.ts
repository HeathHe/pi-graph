/**
 * Human-team task management (team-lite collaboration, Wave 2).
 *
 * Owns `.workflow/collab/tasks/{id}.json` -- per-file task records.
 *
 * Strict namespace separation: this module belongs to the HUMAN collaboration
 * domain (`.workflow/collab/`). It must NEVER touch `.workflow/.team/` which
 * is the agent pipeline message bus owned by `src/tools/team-msg.ts`.
 *
 * Per-file layout is deliberate: each task is a standalone JSON file so that
 * concurrent edits on different machines can merge cleanly via git.
 */
export type TaskStatus = 'open' | 'assigned' | 'in_progress' | 'pending_review' | 'done' | 'closed';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type CheckAction = 'confirmed' | 'rejected' | 'commented';
export interface CheckEntry {
    uid: string;
    action: CheckAction;
    comment?: string;
    ts: string;
}
export interface CollabTask {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee?: string;
    reporter: string;
    check_log: CheckEntry[];
    tags?: string[];
    external_refs?: Array<{
        type: string;
        id: string;
        url?: string;
    }>;
    created_at: string;
    updated_at: string;
    updated_by: string;
}
/** Absolute path to the human-collab tasks directory. */
export declare function getTasksDir(): string;
/** Absolute path to a specific task JSON file. */
export declare function getTaskFilePath(id: string): string;
/**
 * Atomically read and increment the counter file, returning the next
 * `TASK-XXX` formatted id. Creates the counter file at `1` if absent.
 */
export declare function getNextTaskId(): string;
/**
 * Read and validate a task JSON file. Returns null if the file is missing,
 * unparseable, or does not match the CollabTask shape.
 */
export declare function readTaskFile(filePath: string): CollabTask | null;
/**
 * Atomic write of a task JSON file with pretty-printing.
 */
export declare function writeTaskFile(filePath: string, task: CollabTask): void;
/**
 * Create a new task. Generates the id via auto-increment counter, sets
 * defaults (status=open, timestamps), and writes the JSON file.
 */
export declare function createTask(opts: {
    title: string;
    description?: string;
    priority?: TaskPriority;
    reporter: string;
    tags?: string[];
    external_refs?: Array<{
        type: string;
        id: string;
        url?: string;
    }>;
}): CollabTask;
/**
 * Read a single task by id. Returns null if the task does not exist or the
 * file is invalid.
 */
export declare function getTask(id: string): CollabTask | null;
/**
 * Update a task by merging partial fields. Validates status transition if
 * the `status` field is being changed. Throws if the task does not exist or
 * the transition is invalid.
 */
export declare function updateTask(id: string, partial: Partial<CollabTask>): CollabTask;
/**
 * List all tasks, optionally filtered by status, assignee, reporter, or
 * priority. Returns tasks sorted by id ascending.
 */
export declare function listTasks(filters?: {
    status?: TaskStatus;
    assignee?: string;
    reporter?: string;
    priority?: TaskPriority;
}): CollabTask[];
/**
 * Delete a task file. Throws if the task does not exist.
 */
export declare function deleteTask(id: string): void;
/**
 * Assign a task to a member. If the task is currently `open`, automatically
 * transitions to `assigned`.
 */
export declare function assignTask(id: string, uid: string): CollabTask;
/**
 * Update task status with transition validation. Throws if the transition is
 * not allowed by VALID_TRANSITIONS.
 */
export declare function updateTaskStatus(id: string, newStatus: TaskStatus, updatedBy: string): CollabTask;
/**
 * Append a check entry to a task's check_log. The timestamp is auto-generated.
 * Existing entries are never modified or removed (append-only).
 */
export declare function addCheckEntry(id: string, entry: Omit<CheckEntry, 'ts'>): CollabTask;
/**
 * Validate that a status transition is allowed by VALID_TRANSITIONS.
 * A transition from a status to itself is always allowed (no-op).
 */
export declare function validateStatusTransition(from: TaskStatus, to: TaskStatus): boolean;
//# sourceMappingURL=team-tasks.d.ts.map