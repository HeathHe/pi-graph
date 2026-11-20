import { Hono } from 'hono';
import { createHealthRoute } from './health.js';
import { createBoardRoutes } from './board.js';
import { createPhaseRoutes } from './phases.js';
import { createArtifactRoutes } from './artifacts.js';
import { createScratchRoutes } from './scratch.js';
import { createEventsRoute } from './events.js';
import { createAgentRoutes } from './agents.js';
import { createSettingsRoutes } from './settings.js';
import { createIssueRoutes } from './issues.js';
import { createExecutionRoutes } from './execution.js';
import { createCliHistoryRoutes } from './cli-history.js';
import { createMcpRoutes } from './mcp.js';
import { createInstallRoutes } from './install.js';
import { createSpecsRoutes } from './specs.js';
import { createSharedWikiWriter } from './wiki.js';
import { createLinearRoutes } from './linear.js';
import { createTeamRoutes } from './teams.js';
import { createCollabRoutes } from './collab.js';
import { createRoomRoutes } from './rooms.js';
import { createRoomMcpRoutes } from './room-mcp.js';
import { createCommanderRoutes } from '../commander/commander-routes.js';
import { createCoordinatorRoutes } from '../coordinator/coordinator-routes.js';
import { createRequirementRoutes } from './requirements.js';
// Supervisor routes hidden — replaced by MaestroCoordinatePage
// import { createSupervisorRoutes } from './supervisor.js';
import { createMaestroCoordinateRoutes } from './maestro-coordinate.js';
import { createMaestroStatusRoutes } from './maestro-status.js';
import { createWorkspaceRoutes } from './workspace.js';
import { createGitRoutes } from './git.js';
import { createCsvWaveRoutes } from './csv-waves.js';
import { createObservabilityRoutes } from '../observability/observability-routes.js';
/**
 * Aggregate all route modules into a single Hono app.
 *
 * Routes that need StateManager receive it via factory functions.
 * Routes that depend on workflowRoot receive a getter so they follow
 * workspace switches at runtime.
 * The events route receives StateManager, EventBus, and SSEHub.
 * The agent routes receive the AgentManager.
 */
export function createRoutes(stateManager, workflowRoot, eventBus, sseHub, agentManager, executionScheduler, commanderAgent, coordinator, requirementExpander, supervisorDeps, roomSessionManager) {
    const routes = new Hono();
    // Dynamic getter — follows workspace switches
    const getRoot = () => stateManager.getWorkflowRoot();
    // Health (reports workspace) + workspace switch endpoint
    routes.route('/', createHealthRoute(workflowRoot, stateManager));
    // Data routes (depend on StateManager)
    routes.route('/', createBoardRoutes(stateManager));
    routes.route('/', createPhaseRoutes(stateManager));
    routes.route('/', createScratchRoutes(stateManager));
    // Artifact route (dynamic root for workspace switch)
    routes.route('/', createArtifactRoutes(getRoot));
    // Workspace tree route (project root = parent of .workflow/)
    routes.route('/', createWorkspaceRoutes(getRoot));
    // Git source control routes (project root = parent of .workflow/)
    routes.route('/', createGitRoutes(getRoot));
    // CSV Wave routes (reads from .workflow/.csv-wave/)
    routes.route('/', createCsvWaveRoutes(getRoot));
    // Maestro Coordinate routes (reads from .workflow/.maestro/)
    routes.route('/', createMaestroCoordinateRoutes(getRoot));
    // Maestro Status routes (Session/Run 架构状态 + 知识积累统计)
    routes.route('/', createMaestroStatusRoutes(getRoot));
    // SSE events route (depends on StateManager, EventBus, SSEHub)
    routes.route('/', createEventsRoute(stateManager, eventBus, sseHub));
    // Agent routes (depends on AgentManager)
    routes.route('/', createAgentRoutes(agentManager));
    // Settings routes (depends on workflow root for config paths)
    routes.route('/', createSettingsRoutes(getRoot));
    // Issue routes (dynamic root for workspace switch)
    routes.route('/', createIssueRoutes(getRoot));
    // Execution routes (depends on ExecutionScheduler)
    if (executionScheduler) {
        routes.route('/', createExecutionRoutes(executionScheduler));
    }
    // CLI history routes (reads from ~/.maestro/cli-history/)
    routes.route('/', createCliHistoryRoutes());
    // Unified wiki endpoint (graph-aware view + scoped writes across .workflow/)
    const { routes: wikiRoutes, getContext, dispose: disposeWiki } = createSharedWikiWriter(getRoot, eventBus);
    routes.route('/', wikiRoutes);
    // Specs CRUD routes — resolve the shared workspace context per request.
    routes.route('/', createSpecsRoutes(getRoot, getContext));
    // MCP server management routes
    routes.route('/', createMcpRoutes());
    // Install wizard routes (pure file ops, no dependencies)
    routes.route('/', createInstallRoutes());
    // Linear API proxy routes (dynamic root for workspace switch)
    routes.route('/', createLinearRoutes(getRoot));
    // Team session routes (dynamic root for workspace switch)
    routes.route('/', createTeamRoutes(getRoot));
    // Collab routes (human collaboration, dynamic root for workspace switch)
    routes.route('/', createCollabRoutes(getRoot, eventBus));
    // Room session routes (in-memory meeting room management)
    if (roomSessionManager) {
        routes.route('/', createRoomRoutes(roomSessionManager));
        routes.route('/', createRoomMcpRoutes(roomSessionManager));
    }
    // EventBus recent events endpoint (ring buffer audit)
    routes.get('/api/events/recent', (c) => {
        const limit = Number(c.req.query('limit')) || 100;
        const prefix = c.req.query('prefix') || undefined;
        return c.json(eventBus.getRecentEvents(limit, prefix));
    });
    // Commander routes (depends on CommanderAgent)
    if (commanderAgent) {
        routes.route('/', createCommanderRoutes(commanderAgent, workflowRoot));
    }
    // Coordinator routes (depends on WorkflowCoordinator)
    if (coordinator) {
        routes.route('/', createCoordinatorRoutes(coordinator));
    }
    // Requirement routes (depends on RequirementExpander)
    if (requirementExpander) {
        routes.route('/', createRequirementRoutes(requirementExpander));
    }
    // Observability routes (cross-component event timeline)
    routes.route('/', createObservabilityRoutes(workflowRoot));
    // Supervisor routes hidden — replaced by MaestroCoordinatePage
    // if (supervisorDeps) {
    //   routes.route('/', createSupervisorRoutes(
    //     supervisorDeps.learningService,
    //     supervisorDeps.schedulerService,
    //     supervisorDeps.extensionManager,
    //     supervisorDeps.promptRegistry,
    //   ));
    // }
    return Object.assign(routes, { dispose: disposeWiki });
}
//# sourceMappingURL=index.js.map