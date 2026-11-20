export type MessagePriority = 'normal' | 'high' | 'urgent';
export interface RoomMailboxMessage {
    id: string;
    sessionId: string;
    from: string;
    to: string;
    content: string;
    priority: MessagePriority;
    read: boolean;
    createdAt: string;
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
export type RoomAgentStatus = 'idle' | 'active' | 'busy' | 'error' | 'offline';
export interface RoomAgent {
    role: string;
    processId?: string;
    status: RoomAgentStatus;
    joinedAt: string;
    lastActivityAt: string;
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
