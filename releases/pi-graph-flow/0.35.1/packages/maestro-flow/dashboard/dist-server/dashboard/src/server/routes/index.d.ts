import { Hono } from 'hono';
import type { StateManager } from '../state/state-manager.js';
import type { DashboardEventBus } from '../state/event-bus.js';
import type { SSEHub } from '../sse/sse-hub.js';
import type { AgentManager } from '../agents/agent-manager.js';
import type { ExecutionScheduler } from '../execution/execution-scheduler.js';
import type { CommanderAgent } from '../commander/commander-agent.js';
import type { WorkflowCoordinator } from '../coordinator/workflow-coordinator.js';
import type { RequirementExpander } from '../requirement/requirement-expander.js';
import type { SelfLearningService } from '../supervisor/self-learning-service.js';
import type { TaskSchedulerService } from '../supervisor/task-scheduler-service.js';
import type { ExtensionManager } from '../supervisor/extension-manager.js';
import type { PromptRegistry } from '../prompt/prompt-registry.js';
import type { RoomSessionManager } from '../rooms/room-session-manager.js';
export type DisposableDashboardRoutes = Hono & {
    dispose: () => void;
};
/**
 * Aggregate all route modules into a single Hono app.
 *
 * Routes that need StateManager receive it via factory functions.
 * Routes that depend on workflowRoot receive a getter so they follow
 * workspace switches at runtime.
 * The events route receives StateManager, EventBus, and SSEHub.
 * The agent routes receive the AgentManager.
 */
export declare function createRoutes(stateManager: StateManager, workflowRoot: string, eventBus: DashboardEventBus, sseHub: SSEHub, agentManager: AgentManager, executionScheduler?: ExecutionScheduler, commanderAgent?: CommanderAgent, coordinator?: WorkflowCoordinator, requirementExpander?: RequirementExpander, supervisorDeps?: {
    learningService: SelfLearningService;
    schedulerService: TaskSchedulerService;
    extensionManager: ExtensionManager;
    promptRegistry: PromptRegistry;
}, roomSessionManager?: RoomSessionManager): DisposableDashboardRoutes;
