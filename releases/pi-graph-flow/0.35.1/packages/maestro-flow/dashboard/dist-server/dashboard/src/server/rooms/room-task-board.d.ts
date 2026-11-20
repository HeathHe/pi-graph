import type { RoomTask, RoomTaskCreate, RoomTaskUpdate } from './room-types.js';
export declare class RoomTaskBoard {
    private readonly tasks;
    /**
     * Create a task in the session. Auto-links bidirectional blockedBy/blocks.
     * Returns the created task.
     */
    create(sessionId: string, input: RoomTaskCreate): RoomTask;
    /**
     * Update a task by ID. Returns the updated task or undefined if not found.
     */
    update(sessionId: string, taskId: string, patch: RoomTaskUpdate): RoomTask | undefined;
    /** List all tasks in a session */
    list(sessionId: string): RoomTask[];
    /** Get tasks owned by a specific agent role */
    getByOwner(sessionId: string, owner: string): RoomTask[];
    /**
     * Check which tasks become unblocked after a task completes.
     * Removes the completed task from dependents' blockedBy arrays.
     * Returns the list of tasks that became newly unblocked (transitioned from blocked to pending).
     */
    checkUnblocks(sessionId: string, completedTaskId: string): RoomTask[];
    /** Clear all tasks for a session */
    clear(sessionId: string): void;
}
