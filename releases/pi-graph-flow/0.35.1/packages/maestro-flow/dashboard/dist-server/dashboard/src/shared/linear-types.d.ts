/** Linear workflow state (maps to kanban columns) */
export interface LinearWorkflowState {
    id: string;
    name: string;
    type: string;
    color: string;
    position: number;
}
/** Linear issue label */
export interface LinearLabel {
    id: string;
    name: string;
    color: string;
}
/** Linear user (assignee) */
export interface LinearUser {
    id: string;
    name: string;
    displayName: string;
    avatarUrl: string | null;
}
/** Linear issue priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low */
export type LinearPriority = 0 | 1 | 2 | 3 | 4;
export declare const LINEAR_PRIORITY_LABELS: Record<LinearPriority, string>;
export declare const LINEAR_PRIORITY_COLORS: Record<LinearPriority, string>;
/** Linear issue -- flattened from GraphQL response */
export interface LinearIssue {
    id: string;
    identifier: string;
    title: string;
    description: string | null;
    priority: LinearPriority;
    state: LinearWorkflowState;
    assignee: LinearUser | null;
    labels: LinearLabel[];
    createdAt: string;
    updatedAt: string;
    url: string;
}
/** Linear team info */
export interface LinearTeam {
    id: string;
    name: string;
    key: string;
}
/** Kanban column definition for Linear workflow states */
export interface LinearKanbanColumn {
    id: string;
    name: string;
    type: string;
    color: string;
    issues: LinearIssue[];
}
/** Full Linear board state returned by the API */
export interface LinearBoardState {
    team: LinearTeam | null;
    columns: LinearKanbanColumn[];
    totalIssues: number;
}
