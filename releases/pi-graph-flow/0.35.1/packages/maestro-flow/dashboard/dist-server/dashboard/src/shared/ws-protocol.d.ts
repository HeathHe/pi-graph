import type { AgentConfig, AgentProcess, AgentType, NormalizedEntry, ApprovalRequest, AgentStatusPayload, AgentStoppedPayload } from './agent-types.js';
import type { CommanderConfig } from './commander-types.js';
import type { SupervisorConfig } from './execution-types.js';
import type { ExpansionDepth } from './requirement-types.js';
import type { RoomAgentStatus, RoomTaskCreate, RoomTaskUpdate } from './team-types.js';
/** All WebSocket event type discriminators */
export type WsEventType = 'agent:spawned' | 'agent:entry' | 'agent:approval' | 'agent:status' | 'agent:stopped' | 'agent:turnCompleted' | 'agent:thought' | 'agent:streaming' | 'execution:started' | 'execution:completed' | 'execution:failed' | 'execution:scheduler_status' | 'supervisor:status' | 'supervisor:learning_update' | 'supervisor:schedule_triggered' | 'supervisor:schedule_update' | 'supervisor:extension_loaded' | 'supervisor:extension_error' | 'commander:status' | 'commander:tick' | 'commander:decision' | 'commander:config' | 'commander:assess_metrics' | 'commander:error' | 'coordinate:status' | 'coordinate:analyze_metrics' | 'coordinate:step' | 'coordinate:analysis' | 'coordinate:clarification_needed' | 'coordinate:error' | 'requirement:expanded' | 'requirement:refined' | 'requirement:committed' | 'requirement:progress' | 'board:full' | 'phase:updated' | 'task:updated' | 'scratch:updated' | 'project:updated' | 'watcher:error' | 'workspace:switched' | 'heartbeat' | 'connected' | 'wiki:invalidated' | 'collab:members_updated' | 'collab:activity' | 'team:message' | 'team:dispatch' | 'team:phase' | 'team:agent_status' | 'room:created' | 'room:closed' | 'room:agent_joined' | 'room:agent_left' | 'room:agent_status' | 'room:message' | 'room:broadcast' | 'room:task_created' | 'room:task_updated' | 'room:phase_changed' | 'room:snapshot' | 'maestro:session_updated';
/** Envelope for all server-to-client WebSocket messages */
export interface WsServerMessage<T = unknown> {
    type: WsEventType;
    data: T;
    timestamp: string;
}
export type WsAgentSpawnedMessage = WsServerMessage<AgentProcess>;
export type WsAgentEntryMessage = WsServerMessage<NormalizedEntry>;
export type WsAgentApprovalMessage = WsServerMessage<ApprovalRequest>;
export type WsAgentStatusMessage = WsServerMessage<AgentStatusPayload>;
export type WsAgentStoppedMessage = WsServerMessage<AgentStoppedPayload>;
/** Discriminated union of all client-to-server WS actions */
export type WsClientMessage = WsClientSpawnMessage | WsClientStopMessage | WsClientMessageMessage | WsClientDelegateMessage | WsClientApproveMessage | WsClientCliBridgeSpawnMessage | WsClientCliBridgeEntryMessage | WsClientCliBridgeStoppedMessage | WsClientExecuteIssueMessage | WsClientExecuteBatchMessage | WsClientAnalyzeIssueMessage | WsClientPlanIssueMessage | WsClientSupervisorToggleMessage | WsClientCommanderStartMessage | WsClientCommanderStopMessage | WsClientCommanderPauseMessage | WsClientCommanderConfigMessage | WsClientWaveExecuteMessage | WsClientCoordinateStartMessage | WsClientCoordinateStopMessage | WsClientCoordinateResumeMessage | WsClientCoordinateClarifyMessage | WsClientIssuePipelineMessage | WsClientRequirementExpandMessage | WsClientRequirementRefineMessage | WsClientRequirementCommitMessage | WsClientTeamMessageAction | WsClientTeamBroadcastAction | WsClientTeamSetModeAction | WsClientTeamApproveAction | WsClientRoomCreateAction | WsClientRoomCloseAction | WsClientRoomSubscribeAction | WsClientRoomUnsubscribeAction | WsClientRoomAddAgentAction | WsClientRoomRemoveAgentAction | WsClientRoomSetAgentStatusAction | WsClientRoomSendMessageAction | WsClientRoomBroadcastAction | WsClientRoomCreateTaskAction | WsClientRoomUpdateTaskAction | WsClientRoomSnapshotAction;
export interface WsClientSpawnMessage {
    action: 'spawn';
    config: AgentConfig;
}
export interface WsClientStopMessage {
    action: 'stop';
    processId: string;
}
export interface WsClientMessageMessage {
    action: 'message';
    processId: string;
    content: string;
}
export interface WsClientDelegateMessage {
    action: 'delegate:message';
    processId?: string;
    execId?: string;
    content: string;
    delivery: 'inject' | 'after_complete';
}
export interface WsClientApproveMessage {
    action: 'approve';
    processId: string;
    requestId: string;
    allow: boolean;
}
export interface WsClientCliBridgeSpawnMessage {
    action: 'cli:spawned';
    process: AgentProcess;
}
export interface WsClientCliBridgeEntryMessage {
    action: 'cli:entry';
    entry: NormalizedEntry;
}
export interface WsClientCliBridgeStoppedMessage {
    action: 'cli:stopped';
    processId: string;
}
export interface WsClientExecuteIssueMessage {
    action: 'execute:issue';
    issueId: string;
    executor?: AgentType;
}
export interface WsClientExecuteBatchMessage {
    action: 'execute:batch';
    issueIds: string[];
    executor?: AgentType;
    maxConcurrency?: number;
}
export interface WsClientAnalyzeIssueMessage {
    action: 'issue:analyze';
    issueId: string;
    tool?: string;
    depth?: string;
}
export interface WsClientPlanIssueMessage {
    action: 'issue:plan';
    issueId: string;
    tool?: string;
}
export interface WsClientIssuePipelineMessage {
    action: 'issue:pipeline';
    issueId: string;
    tool?: string;
}
export interface WsClientSupervisorToggleMessage {
    action: 'supervisor:toggle';
    enabled: boolean;
    config?: Partial<SupervisorConfig>;
}
export interface WsClientCommanderStartMessage {
    action: 'commander:start';
}
export interface WsClientCommanderStopMessage {
    action: 'commander:stop';
}
export interface WsClientCommanderPauseMessage {
    action: 'commander:pause';
}
export interface WsClientCommanderConfigMessage {
    action: 'commander:config';
    config: Partial<CommanderConfig>;
}
export interface WsClientWaveExecuteMessage {
    action: 'execute:wave';
    issueId: string;
}
export interface WsClientCoordinateStartMessage {
    action: 'coordinate:start';
    intent: string;
    tool?: string;
    autoMode?: boolean;
}
export interface WsClientCoordinateStopMessage {
    action: 'coordinate:stop';
}
export interface WsClientCoordinateResumeMessage {
    action: 'coordinate:resume';
    sessionId?: string;
}
export interface WsClientCoordinateClarifyMessage {
    action: 'coordinate:clarify';
    sessionId: string;
    response: string;
}
export interface WsClientRequirementExpandMessage {
    action: 'requirement:expand';
    text: string;
    depth?: ExpansionDepth;
    method?: 'sdk' | 'cli';
}
export interface WsClientRequirementRefineMessage {
    action: 'requirement:refine';
    requirementId: string;
    feedback: string;
}
export interface WsClientRequirementCommitMessage {
    action: 'requirement:commit';
    requirementId: string;
    mode: 'issues' | 'coordinate';
}
/** Send a message to a specific agent role in a team session */
export interface WsClientTeamMessageAction {
    action: 'team:message';
    sessionId: string;
    to: string;
    content: string;
}
/** Broadcast a message to all agents in a team session */
export interface WsClientTeamBroadcastAction {
    action: 'team:broadcast';
    sessionId: string;
    content: string;
}
/** Toggle auto/manual mode for a team session */
export interface WsClientTeamSetModeAction {
    action: 'team:set_mode';
    sessionId: string;
    mode: 'auto' | 'manual';
}
/** Approve a pending action in a team session */
export interface WsClientTeamApproveAction {
    action: 'team:approve';
    sessionId: string;
    requestId: string;
    allow: boolean;
}
/** Create a new meeting room session */
export interface WsClientRoomCreateAction {
    action: 'room:create';
    sessionId: string;
}
/** Close (destroy) a meeting room session */
export interface WsClientRoomCloseAction {
    action: 'room:close';
    sessionId: string;
}
/** Subscribe to real-time events for a specific room session */
export interface WsClientRoomSubscribeAction {
    action: 'room:subscribe';
    sessionId: string;
}
/** Unsubscribe from a specific room session's events */
export interface WsClientRoomUnsubscribeAction {
    action: 'room:unsubscribe';
    sessionId: string;
}
/** Add an agent to a room session */
export interface WsClientRoomAddAgentAction {
    action: 'room:add_agent';
    sessionId: string;
    role: string;
    processId?: string;
}
/** Remove an agent from a room session */
export interface WsClientRoomRemoveAgentAction {
    action: 'room:remove_agent';
    sessionId: string;
    role: string;
}
/** Update an agent's status in a room session */
export interface WsClientRoomSetAgentStatusAction {
    action: 'room:set_agent_status';
    sessionId: string;
    role: string;
    status: RoomAgentStatus;
}
/** Send a message to a specific agent in a room session */
export interface WsClientRoomSendMessageAction {
    action: 'room:send_message';
    sessionId: string;
    to: string;
    content: string;
    priority?: 'normal' | 'high' | 'urgent';
}
/** Broadcast a message to all agents in a room session */
export interface WsClientRoomBroadcastAction {
    action: 'room:broadcast';
    sessionId: string;
    content: string;
    priority?: 'normal' | 'high' | 'urgent';
}
/** Create a task in a room session */
export interface WsClientRoomCreateTaskAction {
    action: 'room:create_task';
    sessionId: string;
    task: RoomTaskCreate;
}
/** Update a task in a room session */
export interface WsClientRoomUpdateTaskAction {
    action: 'room:update_task';
    sessionId: string;
    taskId: string;
    patch: RoomTaskUpdate;
}
/** Request the current snapshot of a room session */
export interface WsClientRoomSnapshotAction {
    action: 'room:snapshot';
    sessionId: string;
}
export interface ExecutionStartedPayload {
    issueId: string;
    processId: string;
    executor: AgentType;
    /** Optional: updated issue for incremental client-side update */
    issue?: import('./issue-types.js').Issue;
}
export interface ExecutionCompletedPayload {
    issueId: string;
    processId: string;
    /** Optional: updated issue for incremental client-side update */
    issue?: import('./issue-types.js').Issue;
}
export interface ExecutionFailedPayload {
    issueId: string;
    processId: string;
    error: string;
    /** Optional: updated issue for incremental client-side update */
    issue?: import('./issue-types.js').Issue;
}
export declare const WS_ENDPOINT = "/ws";
