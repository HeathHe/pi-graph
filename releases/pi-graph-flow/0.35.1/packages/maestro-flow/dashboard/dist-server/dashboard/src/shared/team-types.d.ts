export interface PipelineNode {
    id: string;
    name: string;
    status: 'done' | 'in_progress' | 'pending' | 'skipped';
    wave?: number;
}
export interface TeamRole {
    name: string;
    prefix: string;
    status: 'done' | 'active' | 'pending' | 'injected';
    taskCount: number;
    innerLoop: boolean;
    injected?: boolean;
    injectionReason?: string;
}
export interface TeamMessage {
    id: string;
    ts: string;
    from: string;
    to: string;
    type: string;
    summary: string;
    data?: Record<string, unknown>;
}
export interface SessionFileEntry {
    id: string;
    path: string;
    name: string;
    category: 'artifacts' | 'role-specs' | 'session' | 'wisdom' | 'message-bus';
    status?: string;
    isNew?: boolean;
}
export interface TeamSessionSummary {
    sessionId: string;
    title: string;
    description: string;
    status: 'active' | 'paused' | 'completed' | 'failed' | 'abandoned' | 'archived';
    health: 'fresh' | 'idle' | 'stale_candidate' | 'inconsistent' | 'unknown';
    cleanupEligible: boolean;
    skill: string;
    roles: string[];
    taskProgress: {
        completed: number;
        total: number;
    };
    messageCount: number;
    duration: string;
    createdAt: string;
    updatedAt: string;
    pipelineStages: PipelineNode[];
}
export interface TeamSessionDetail extends TeamSessionSummary {
    roleDetails: TeamRole[];
    messages: TeamMessage[];
    files: SessionFileEntry[];
    pipeline: {
        waves: {
            number: number;
            nodes: PipelineNode[];
        }[];
    };
}
export declare const SKILL_PREFIX_MAP: Record<string, string>;
export declare function inferSkill(sessionId: string): string;
export type MailboxDispatchStatus = 'pending' | 'delivered' | 'acknowledged' | 'failed';
export interface TeamMailboxMessage {
    id: string;
    from: string;
    to: string;
    content: string;
    dispatch_status: MailboxDispatchStatus;
    timestamp: string;
}
export type TeamPhaseName = 'initialization' | 'planning' | 'execution' | 'review' | 'completion';
export interface TeamPhaseState {
    current: TeamPhaseName;
    history: TeamPhaseName[];
    fixAttempts: number;
}
export type TeamAgentRoleStatus = 'idle' | 'active' | 'busy' | 'error' | 'offline';
export interface TeamAgentStatus {
    role: string;
    status: TeamAgentRoleStatus;
    lastActivity: string;
}
export type RoomAgentStatus = 'idle' | 'active' | 'busy' | 'error' | 'offline';
export interface RoomAgent {
    role: string;
    processId?: string;
    status: RoomAgentStatus;
    joinedAt: string;
    lastActivityAt: string;
}
export type RoomTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
export interface RoomTask {
    id: string;
    sessionId: string;
    title: string;
    description: string;
    status: RoomTaskStatus;
    owner?: string;
    blockedBy: string[];
    blocks: string[];
    createdAt: string;
    updatedAt: string;
}
export interface RoomTaskCreate {
    title: string;
    description: string;
    owner?: string;
    blockedBy?: string[];
}
export interface RoomTaskUpdate {
    title?: string;
    description?: string;
    status?: RoomTaskStatus;
    owner?: string;
}
export type RoomMessagePriority = 'normal' | 'high' | 'urgent';
export interface RoomMailboxMessage {
    id: string;
    sessionId: string;
    from: string;
    to: string;
    content: string;
    priority: RoomMessagePriority;
    read: boolean;
    createdAt: string;
}
export type RoomSessionStatus = 'active' | 'paused' | 'destroyed';
export interface RoomSessionSnapshot {
    sessionId: string;
    status: RoomSessionStatus;
    agents: RoomAgent[];
    messages: RoomMailboxMessage[];
    tasks: RoomTask[];
    createdAt: string;
}
export interface RoomSessionSummary {
    sessionId: string;
    status: RoomSessionStatus;
    agentCount: number;
    taskCount: number;
    messageCount: number;
    createdAt: string;
}
export interface RoomSessionConfig {
    sessionId: string;
    roles: string[];
    autoMode?: boolean;
}
export declare const TEAM_STATUS_COLORS: Record<TeamSessionSummary['status'], string>;
export declare const PIPELINE_STATUS_COLORS: Record<PipelineNode['status'], string>;
export declare const ROLE_STATUS_COLORS: Record<TeamRole['status'], string>;
export declare const AGENT_STATUS_COLORS: Record<TeamAgentRoleStatus, string>;
