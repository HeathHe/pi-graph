// ---------------------------------------------------------------------------
// Collab Types — shared between server and client for human collaboration
// ---------------------------------------------------------------------------
export const COLLAB_STATUS_COLORS = {
    online: '#22c55e',
    offline: '#9ca3af',
    away: '#eab308',
};
/** Color per activity action type — shared across components */
export const COLLAB_ACTION_COLORS = {
    join: '#22c55e',
    phase_change: '#a78bfa',
    task_update: '#34d399',
    message: '#60a5fa',
    discussion: '#60a5fa',
    report: '#f59e0b',
    sync: '#06b6d4',
};
export const COLLAB_TASK_STATUS_COLORS = {
    backlog: '#9ca3af',
    todo: '#60a5fa',
    in_progress: '#a78bfa',
    review: '#f59e0b',
    done: '#22c55e',
};
export const COLLAB_TASK_PRIORITY_COLORS = {
    low: '#9ca3af',
    medium: '#60a5fa',
    high: '#f59e0b',
    critical: '#ef4444',
};
export const COLLAB_TASK_COLUMNS = [
    { id: 'backlog', label: 'Backlog', color: COLLAB_TASK_STATUS_COLORS.backlog },
    { id: 'todo', label: 'To Do', color: COLLAB_TASK_STATUS_COLORS.todo },
    { id: 'in_progress', label: 'In Progress', color: COLLAB_TASK_STATUS_COLORS.in_progress },
    { id: 'review', label: 'Review', color: COLLAB_TASK_STATUS_COLORS.review },
    { id: 'done', label: 'Done', color: COLLAB_TASK_STATUS_COLORS.done },
];
/** Allowed status transitions per current status */
export const COLLAB_TASK_TRANSITIONS = {
    backlog: ['todo'],
    todo: ['in_progress', 'backlog'],
    in_progress: ['review', 'todo'],
    review: ['done', 'in_progress'],
    done: ['review'],
};
//# sourceMappingURL=collab-types.js.map