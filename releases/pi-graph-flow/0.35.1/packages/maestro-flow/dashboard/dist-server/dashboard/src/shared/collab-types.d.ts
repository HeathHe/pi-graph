export interface CollabMember {
    uid: string;
    name: string;
    email: string;
    status: 'online' | 'offline' | 'away';
    currentPhase?: string;
    currentTask?: string;
    lastSeen: string;
    joinedAt: string;
    role: string;
    host: string;
}
export interface CollabActivityEntry {
    ts: string;
    user: string;
    host: string;
    action: string;
    phase_id?: string;
    task_id?: string;
    target?: string;
}
export interface CollabPresence {
    uid: string;
    name: string;
    status: 'online' | 'offline' | 'away';
    lastSeen: string;
}
export interface CollabAggregatedActivity {
    phase: string;
    task: string;
    count: number;
    members: string[];
    risk: 'none' | 'low' | 'medium' | 'high';
}
export interface CollabPreflightResult {
    exists: boolean;
    memberCount: number;
    hasActivity: boolean;
}
export declare const COLLAB_STATUS_COLORS: Record<'online' | 'offline' | 'away', string>;
/** Color per activity action type — shared across components */
export declare const COLLAB_ACTION_COLORS: Record<string, string>;
export type CollabTaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done';
export type CollabTaskPriority = 'low' | 'medium' | 'high' | 'critical';
export type CollabCheckAction = 'confirm' | 'reject' | 'comment';
export interface CollabCheckEntry {
    ts: string;
    author: string;
    action: CollabCheckAction;
    comment?: string;
}
export interface CollabTask {
    id: string;
    title: string;
    description: string;
    status: CollabTaskStatus;
    priority: CollabTaskPriority;
    assignee: string | null;
    reporter: string | null;
    tags: string[];
    check_log: CollabCheckEntry[];
    created_at: string;
    updated_at: string;
}
export declare const COLLAB_TASK_STATUS_COLORS: Record<CollabTaskStatus, string>;
export declare const COLLAB_TASK_PRIORITY_COLORS: Record<CollabTaskPriority, string>;
export declare const COLLAB_TASK_COLUMNS: {
    id: CollabTaskStatus;
    label: string;
    color: string;
}[];
/** Allowed status transitions per current status */
export declare const COLLAB_TASK_TRANSITIONS: Record<CollabTaskStatus, CollabTaskStatus[]>;
