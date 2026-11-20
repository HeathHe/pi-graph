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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, } from 'node:fs';
import { join } from 'node:path';
import { getProjectRoot } from '../utils/path-validator.js';
import { resolveSelf } from './team-members.js';
import { reportActivity } from './team-activity.js';
import { notifyAdapters } from './collab-adapter.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS = {
    'open': ['assigned', 'closed'],
    'assigned': ['in_progress', 'open', 'closed'],
    'in_progress': ['pending_review', 'assigned', 'closed'],
    'pending_review': ['done', 'in_progress', 'closed'],
    'done': ['closed', 'pending_review'],
    'closed': ['open'], // reopen
};
// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
/** Absolute path to the human-collab tasks directory. */
export function getTasksDir() {
    const dir = join(getProjectRoot(), '.workflow', 'collab', 'tasks');
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    return dir;
}
/** Absolute path to a specific task JSON file. */
export function getTaskFilePath(id) {
    return join(getTasksDir(), `${id}.json`);
}
/** Absolute path to the auto-increment counter file. */
function getCounterFilePath() {
    return join(getTasksDir(), '.counter');
}
// ---------------------------------------------------------------------------
// Counter / ID generation
// ---------------------------------------------------------------------------
/**
 * Atomically read and increment the counter file, returning the next
 * `TASK-XXX` formatted id. Creates the counter file at `1` if absent.
 */
export function getNextTaskId() {
    const counterPath = getCounterFilePath();
    let next = 1;
    if (existsSync(counterPath)) {
        const raw = readFileSync(counterPath, 'utf-8').trim();
        const parsed = parseInt(raw, 10);
        if (!Number.isNaN(parsed)) {
            next = parsed;
        }
    }
    const id = `TASK-${String(next).padStart(3, '0')}`;
    writeFileSync(counterPath, String(next + 1), 'utf-8');
    return id;
}
// ---------------------------------------------------------------------------
// Internal read/write
// ---------------------------------------------------------------------------
/**
 * Read and validate a task JSON file. Returns null if the file is missing,
 * unparseable, or does not match the CollabTask shape.
 */
export function readTaskFile(filePath) {
    if (!existsSync(filePath))
        return null;
    try {
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.id === 'string' &&
            typeof parsed.title === 'string' &&
            typeof parsed.description === 'string' &&
            typeof parsed.status === 'string' &&
            typeof parsed.priority === 'string' &&
            typeof parsed.reporter === 'string' &&
            Array.isArray(parsed.check_log) &&
            typeof parsed.created_at === 'string' &&
            typeof parsed.updated_at === 'string' &&
            typeof parsed.updated_by === 'string') {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
/**
 * Atomic write of a task JSON file with pretty-printing.
 */
export function writeTaskFile(filePath, task) {
    writeFileSync(filePath, JSON.stringify(task, null, 2), 'utf-8');
}
// ---------------------------------------------------------------------------
// CRUD operations
// ---------------------------------------------------------------------------
/**
 * Create a new task. Generates the id via auto-increment counter, sets
 * defaults (status=open, timestamps), and writes the JSON file.
 */
export function createTask(opts) {
    const id = getNextTaskId();
    const now = new Date().toISOString();
    const task = {
        id,
        title: opts.title,
        description: opts.description ?? '',
        status: 'open',
        priority: opts.priority ?? 'medium',
        reporter: opts.reporter,
        check_log: [],
        ...(opts.tags && opts.tags.length > 0 ? { tags: opts.tags } : {}),
        ...(opts.external_refs && opts.external_refs.length > 0 ? { external_refs: opts.external_refs } : {}),
        created_at: now,
        updated_at: now,
        updated_by: opts.reporter,
    };
    writeTaskFile(getTaskFilePath(id), task);
    try {
        notifyAdapters({
            type: 'task.created',
            payload: { id: task.id, title: task.title, priority: task.priority, reporter: task.reporter },
        });
    }
    catch { /* fire-and-forget: never block */ }
    return task;
}
/**
 * Read a single task by id. Returns null if the task does not exist or the
 * file is invalid.
 */
export function getTask(id) {
    const filePath = getTaskFilePath(id);
    return readTaskFile(filePath);
}
/**
 * Update a task by merging partial fields. Validates status transition if
 * the `status` field is being changed. Throws if the task does not exist or
 * the transition is invalid.
 */
export function updateTask(id, partial) {
    const task = getTask(id);
    if (!task) {
        throw new Error(`Task not found: ${id}`);
    }
    // Validate status transition if status is being changed.
    if (partial.status !== undefined && partial.status !== task.status) {
        if (!validateStatusTransition(task.status, partial.status)) {
            throw new Error(`Invalid status transition: ${task.status} -> ${partial.status}`);
        }
    }
    const now = new Date().toISOString();
    const updated = {
        ...task,
        ...partial,
        id: task.id, // id is immutable
        created_at: task.created_at, // created_at is immutable
        updated_at: now,
    };
    writeTaskFile(getTaskFilePath(id), updated);
    return updated;
}
/**
 * List all tasks, optionally filtered by status, assignee, reporter, or
 * priority. Returns tasks sorted by id ascending.
 */
export function listTasks(filters) {
    const dir = getTasksDir();
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json'))
            continue;
        const task = readTaskFile(join(dir, entry));
        if (!task)
            continue;
        if (filters) {
            if (filters.status !== undefined && task.status !== filters.status)
                continue;
            if (filters.assignee !== undefined && task.assignee !== filters.assignee)
                continue;
            if (filters.reporter !== undefined && task.reporter !== filters.reporter)
                continue;
            if (filters.priority !== undefined && task.priority !== filters.priority)
                continue;
        }
        out.push(task);
    }
    // Sort by id ascending (TASK-001 before TASK-002).
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}
/**
 * Delete a task file. Throws if the task does not exist.
 */
export function deleteTask(id) {
    const filePath = getTaskFilePath(id);
    if (!existsSync(filePath)) {
        throw new Error(`Task not found: ${id}`);
    }
    unlinkSync(filePath);
}
// ---------------------------------------------------------------------------
// Task operations
// ---------------------------------------------------------------------------
/**
 * Assign a task to a member. If the task is currently `open`, automatically
 * transitions to `assigned`.
 */
export function assignTask(id, uid) {
    const task = getTask(id);
    if (!task) {
        throw new Error(`Task not found: ${id}`);
    }
    const newStatus = task.status === 'open' ? 'assigned' : task.status;
    const now = new Date().toISOString();
    const updated = {
        ...task,
        assignee: uid,
        status: newStatus,
        updated_at: now,
        updated_by: uid,
    };
    writeTaskFile(getTaskFilePath(id), updated);
    try {
        const self = resolveSelf();
        if (self) {
            reportActivity({
                user: self.uid,
                host: self.host,
                action: 'task.assigned',
                task_id: task.id,
                target: uid,
            });
        }
    }
    catch { /* hot-path: never throw */ }
    try {
        notifyAdapters({
            type: 'task.assigned',
            payload: { id: task.id, assignee: uid },
            recipients: [uid],
        });
    }
    catch { /* fire-and-forget: never block */ }
    return updated;
}
/**
 * Update task status with transition validation. Throws if the transition is
 * not allowed by VALID_TRANSITIONS.
 */
export function updateTaskStatus(id, newStatus, updatedBy) {
    const task = getTask(id);
    if (!task) {
        throw new Error(`Task not found: ${id}`);
    }
    if (!validateStatusTransition(task.status, newStatus)) {
        throw new Error(`Invalid status transition: ${task.status} -> ${newStatus}`);
    }
    const oldStatus = task.status;
    const now = new Date().toISOString();
    const updated = {
        ...task,
        status: newStatus,
        updated_at: now,
        updated_by: updatedBy,
    };
    writeTaskFile(getTaskFilePath(id), updated);
    try {
        const self = resolveSelf();
        if (self) {
            reportActivity({
                user: self.uid,
                host: self.host,
                action: 'task.status_changed',
                task_id: task.id,
                target: `${oldStatus}->${newStatus}`,
            });
        }
    }
    catch { /* hot-path: never throw */ }
    try {
        notifyAdapters({
            type: 'task.status_changed',
            payload: { id: task.id, from: oldStatus, to: newStatus },
        });
    }
    catch { /* fire-and-forget: never block */ }
    return updated;
}
/**
 * Append a check entry to a task's check_log. The timestamp is auto-generated.
 * Existing entries are never modified or removed (append-only).
 */
export function addCheckEntry(id, entry) {
    const task = getTask(id);
    if (!task) {
        throw new Error(`Task not found: ${id}`);
    }
    const fullEntry = {
        ...entry,
        ts: new Date().toISOString(),
    };
    const now = new Date().toISOString();
    const updated = {
        ...task,
        check_log: [...task.check_log, fullEntry],
        updated_at: now,
        updated_by: entry.uid,
    };
    writeTaskFile(getTaskFilePath(id), updated);
    try {
        const self = resolveSelf();
        if (self) {
            reportActivity({
                user: self.uid,
                host: self.host,
                action: 'task.checked',
                task_id: task.id,
                target: entry.action,
            });
        }
    }
    catch { /* hot-path: never throw */ }
    try {
        notifyAdapters({
            type: 'task.checked',
            payload: { id: task.id, action: entry.action, uid: entry.uid },
        });
    }
    catch { /* fire-and-forget: never block */ }
    return updated;
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
/**
 * Validate that a status transition is allowed by VALID_TRANSITIONS.
 * A transition from a status to itself is always allowed (no-op).
 */
export function validateStatusTransition(from, to) {
    if (from === to)
        return true;
    const allowed = VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
}
//# sourceMappingURL=team-tasks.js.map