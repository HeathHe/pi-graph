import type { PhaseStatus, TaskStatus, SSEEventType } from './types.js';
import type { WsEventType } from './ws-protocol.js';
import type { AgentType } from './agent-types.js';
import type { Issue } from './issue-types.js';
export declare const PHASE_STATUSES: readonly PhaseStatus[];
export declare const TASK_STATUSES: readonly TaskStatus[];
export interface ColumnDefinition {
    id: string;
    label: string;
    statuses: readonly PhaseStatus[];
}
export declare const COLLAPSED_COLUMNS: readonly ColumnDefinition[];
export declare const SSE_EVENT_TYPES: Record<string, SSEEventType>;
export declare const API_ENDPOINTS: {
    readonly HEALTH: "/api/health";
    readonly BOARD: "/api/board";
    readonly PROJECT: "/api/project";
    readonly PHASES: "/api/phases";
    readonly PHASE: "/api/phases/:n";
    readonly PHASE_TASKS: "/api/phases/:n/tasks";
    readonly ARTIFACTS: "/api/artifacts";
    readonly SCRATCH: "/api/scratch";
    readonly SETTINGS: "/api/settings";
    readonly SETTINGS_GENERAL: "/api/settings/general";
    readonly SETTINGS_AGENTS: "/api/settings/agents";
    readonly SETTINGS_CLI_TOOLS: "/api/settings/cli-tools";
    readonly SETTINGS_SPECS: "/api/settings/specs";
};
export declare const SPECS_API_ENDPOINTS: {
    readonly SPECS: "/api/specs";
    readonly SPECS_FILES: "/api/specs/files";
    readonly SPECS_FILE: "/api/specs/file/:name";
    readonly SPECS_SCOPES: "/api/specs/scopes";
};
export declare const WIKI_API_ENDPOINTS: {
    readonly WIKI: "/api/wiki";
    readonly WIKI_STATS: "/api/wiki/stats";
    readonly WIKI_HEALTH: "/api/wiki/health";
    readonly WIKI_GRAPH: "/api/wiki/graph";
    readonly WIKI_ORPHANS: "/api/wiki/orphans";
    readonly WIKI_HUBS: "/api/wiki/hubs";
    readonly WIKI_DETAIL: "/api/wiki/:id";
    readonly WIKI_BACKLINKS: "/api/wiki/:id/backlinks";
    readonly WIKI_FORWARD: "/api/wiki/:id/forward";
};
export declare const MCP_API_ENDPOINTS: {
    readonly CONFIG: "/api/mcp-config";
    readonly TOGGLE: "/api/mcp-toggle";
    readonly COPY_SERVER: "/api/mcp-copy-server";
    readonly REMOVE_SERVER: "/api/mcp-remove-server";
    readonly ADD_GLOBAL: "/api/mcp-add-global-server";
    readonly REMOVE_GLOBAL: "/api/mcp-remove-global-server";
    readonly UPDATE_SERVER: "/api/mcp-update-server";
    readonly INSTALL_MAESTRO: "/api/mcp-install-maestro";
    readonly CODEX_CONFIG: "/api/codex-mcp-config";
    readonly CODEX_ADD: "/api/codex-mcp-add";
    readonly CODEX_REMOVE: "/api/codex-mcp-remove";
    readonly CODEX_TOGGLE: "/api/codex-mcp-toggle";
    readonly TEMPLATES: "/api/mcp-templates";
    readonly TEMPLATES_SEARCH: "/api/mcp-templates/search";
    readonly TEMPLATES_CATEGORIES: "/api/mcp-templates/categories";
    readonly TEMPLATES_INSTALL: "/api/mcp-templates/install";
    readonly DETECT_COMMANDS: "/api/mcp/detect-commands";
};
export declare const SSE_ENDPOINT = "/events";
export declare const WS_EVENT_TYPES: Record<string, WsEventType>;
export declare const AGENT_API_ENDPOINTS: {
    readonly SPAWN: "/api/agent/spawn";
    readonly STOP: "/api/agent/stop";
    readonly MESSAGE: "/api/agent/message";
    readonly APPROVE: "/api/agent/approve";
    readonly LIST: "/api/agent/list";
    readonly ENTRIES: "/api/agent/entries";
};
export declare const ISSUE_API_ENDPOINTS: {
    readonly ISSUES: "/api/issues";
    readonly ISSUE: "/api/issues/:id";
};
export declare const EXECUTION_API_ENDPOINTS: {
    readonly DISPATCH: "/api/execution/dispatch";
    readonly BATCH: "/api/execution/batch";
    readonly CANCEL: "/api/execution/cancel";
    readonly STATUS: "/api/execution/status";
    readonly SUPERVISOR: "/api/execution/supervisor";
};
export declare const LINEAR_API_ENDPOINTS: {
    readonly STATUS: "/api/linear/status";
    readonly TEAMS: "/api/linear/teams";
    readonly BOARD: "/api/linear/board";
    readonly IMPORT: "/api/linear/import";
    readonly EXPORT: "/api/linear/export";
};
export declare const TEAM_API_ENDPOINTS: {
    readonly SESSIONS: "/api/teams/sessions";
    readonly SESSION: "/api/teams/sessions/:sessionId";
    readonly SESSION_MESSAGES: "/api/teams/sessions/:sessionId/messages";
    readonly SESSION_FILE: "/api/teams/sessions/:sessionId/files";
};
export declare const COLLAB_API_ENDPOINTS: {
    readonly MEMBERS: "/api/collab/members";
    readonly ACTIVITY: "/api/collab/activity";
    readonly STATUS: "/api/collab/status";
    readonly AGGREGATED: "/api/collab/activity/aggregated";
    readonly PREFLIGHT: "/api/collab/preflight";
};
export declare const WS_ENDPOINT = "/ws";
export declare const DEFAULT_CONFIG: {
    readonly serverPort: 3001;
    readonly serverHost: "127.0.0.1";
    readonly watchDebounceMs: 150;
    readonly sseHeartbeatMs: 30000;
    readonly sseMaxConnections: 10;
};
export declare const CLI_HISTORY_DIR_NAME = "cli-history";
export declare const INSTALL_API_ENDPOINTS: {
    readonly DETECT: "/api/install/detect";
    readonly EXECUTE: "/api/install/execute";
    readonly MANIFESTS: "/api/install/manifests";
    readonly ADDONS: "/api/install/addons";
    readonly ADDON_INSTALL: "/api/install/addon";
};
export declare const STATUS_COLORS: Record<PhaseStatus, string>;
export declare const AGENT_DOT_COLORS: Record<AgentType, string>;
export declare const AGENT_LABELS: Record<AgentType, string>;
/** UI-derived status that includes metadata-based states */
export type DisplayStatus = 'open' | 'registered' | 'analyzing' | 'planned' | 'in_progress' | 'resolved' | 'closed' | 'deferred';
export declare const ISSUE_DISPLAY_STATUS_COLORS: Record<DisplayStatus, string>;
/**
 * Derive display status from issue.status + metadata (analysis/solution presence).
 * Maps the raw IssueStatus to a richer UI state based on attached data.
 */
export declare function getDisplayStatus(issue: Issue): DisplayStatus;
