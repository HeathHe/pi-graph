import type { SSEEvent, SSEEventType, BoardState, PhaseCard, TaskCard, ScratchCard, ProjectState } from '../../shared/types.js';
import type { AgentProcess, NormalizedEntry, ApprovalRequest, AgentStatusPayload, AgentStoppedPayload, AgentTurnCompletedPayload } from '../../shared/agent-types.js';
import type { SupervisorStatus } from '../../shared/execution-types.js';
import type { LearningStats } from '../../shared/learning-types.js';
import type { ScheduledTask } from '../../shared/schedule-types.js';
import type { ExtensionInfo } from '../../shared/extension-types.js';
import type { CommanderState, Decision, CommanderConfig, AssessMetrics } from '../../shared/commander-types.js';
import type { CoordinateStatusPayload, CoordinateStepPayload, CoordinateAnalysisPayload, CoordinateClarificationPayload } from '../../shared/coordinate-types.js';
import type { RequirementProgressPayload, RequirementExpandedPayload, RequirementCommittedPayload } from '../../shared/requirement-types.js';
import type { ExecutionStartedPayload, ExecutionCompletedPayload, ExecutionFailedPayload } from '../../shared/ws-protocol.js';
import type { MaestroSessionUpdatedPayload } from '../../shared/maestro-session-types.js';
import type { CollabMember, CollabActivityEntry } from '../../shared/collab-types.js';
import type { TeamMailboxMessage, TeamPhaseState, TeamAgentStatus, RoomSessionSnapshot, RoomSessionSummary, RoomAgent, RoomAgentStatus as RoomAgentStatusType, RoomMailboxMessage, RoomTask, RoomSessionStatus } from '../../shared/team-types.js';
export interface DashboardEventMap {
    'board:full': BoardState;
    'phase:updated': PhaseCard;
    'task:updated': TaskCard;
    'scratch:updated': ScratchCard;
    'project:updated': ProjectState;
    'watcher:error': string;
    'heartbeat': null;
    'connected': null;
    'agent:spawned': AgentProcess;
    'agent:entry': NormalizedEntry;
    'agent:approval': ApprovalRequest;
    'agent:status': AgentStatusPayload;
    'agent:stopped': AgentStoppedPayload;
    'agent:turnCompleted': AgentTurnCompletedPayload;
    'execution:started': ExecutionStartedPayload;
    'execution:completed': ExecutionCompletedPayload;
    'execution:failed': ExecutionFailedPayload;
    'execution:scheduler_status': SupervisorStatus;
    'supervisor:status': SupervisorStatus;
    'supervisor:learning_update': LearningStats;
    'supervisor:schedule_triggered': {
        taskId: string;
        taskName: string;
        taskType: string;
    };
    'supervisor:schedule_update': {
        tasks: ScheduledTask[];
    };
    'supervisor:extension_loaded': {
        extensions: ExtensionInfo[];
    };
    'supervisor:extension_error': {
        name: string;
        error: string;
    };
    'commander:status': CommanderState;
    'commander:tick': CommanderState;
    'commander:decision': Decision;
    'commander:config': CommanderConfig;
    'commander:assess_metrics': AssessMetrics;
    'commander:error': {
        error: string;
        context: string;
        timestamp: number;
    };
    'coordinate:status': CoordinateStatusPayload;
    'coordinate:step': CoordinateStepPayload;
    'coordinate:analysis': CoordinateAnalysisPayload;
    'coordinate:clarification_needed': CoordinateClarificationPayload;
    'coordinate:analyze_metrics': AssessMetrics;
    'coordinate:error': {
        error: string;
        context: string;
        step: number;
        timestamp: number;
    };
    'requirement:expanded': RequirementExpandedPayload;
    'requirement:refined': RequirementExpandedPayload;
    'requirement:committed': RequirementCommittedPayload;
    'requirement:progress': RequirementProgressPayload;
    'workspace:switched': {
        workspace: string;
    };
    'wiki:invalidated': {
        at: number;
        path?: string;
    };
    'collab:members_updated': CollabMember[];
    'collab:activity': CollabActivityEntry;
    'team:message': TeamMailboxMessage;
    'team:dispatch': TeamMailboxMessage;
    'team:phase': TeamPhaseState;
    'team:agent_status': TeamAgentStatus;
    'room:created': RoomSessionSummary;
    'room:closed': {
        sessionId: string;
    };
    'room:agent_joined': {
        sessionId: string;
        agent: RoomAgent;
    };
    'room:agent_left': {
        sessionId: string;
        role: string;
    };
    'room:agent_status': {
        sessionId: string;
        role: string;
        status: RoomAgentStatusType;
    };
    'room:message': {
        sessionId: string;
        message: RoomMailboxMessage;
    };
    'room:broadcast': {
        sessionId: string;
        message: RoomMailboxMessage;
    };
    'room:task_created': {
        sessionId: string;
        task: RoomTask;
    };
    'room:task_updated': {
        sessionId: string;
        task: RoomTask;
    };
    'room:phase_changed': {
        sessionId: string;
        status: RoomSessionStatus;
    };
    'room:snapshot': RoomSessionSnapshot;
    'maestro:session_updated': MaestroSessionUpdatedPayload;
}
export declare class DashboardEventBus {
    private readonly emitter;
    private readonly ringBuffer;
    private readonly maxBufferSize;
    constructor();
    /** Emit a typed dashboard event */
    emit<K extends SSEEventType & keyof DashboardEventMap>(type: K, data: DashboardEventMap[K]): void;
    /** Get recent events from the ring buffer, optionally filtered by type prefix */
    getRecentEvents(limit?: number, typePrefix?: string): SSEEvent[];
    /** Get current ring buffer size */
    getBufferSize(): number;
    /** Subscribe to a specific event type */
    on<K extends SSEEventType & keyof DashboardEventMap>(type: K, listener: (event: SSEEvent) => void): void;
    /** Unsubscribe from a specific event type */
    off<K extends SSEEventType & keyof DashboardEventMap>(type: K, listener: (event: SSEEvent) => void): void;
    /** Subscribe to all event types */
    onAny(listener: (event: SSEEvent) => void): void;
    /** Unsubscribe from all event types */
    offAny(listener: (event: SSEEvent) => void): void;
    /** Remove all listeners */
    removeAllListeners(): void;
}
