import type { AgentType } from '../shared/agent-types.js';
export interface DashboardConfig {
    port: number;
    host: string;
    debounce_ms: number;
    polling_fallback: boolean;
    heartbeat_interval_ms: number;
    max_connections: number;
    workflow_root: string;
}
/**
 * Load dashboard configuration from .workflow/config.json `dashboard` section.
 * Falls back to defaults when file is missing or section is absent.
 */
export declare function loadConfig(cwd?: string): Promise<DashboardConfig>;
export interface SavedAgentSettings {
    model?: string;
    approvalMode?: 'suggest' | 'auto';
    baseUrl?: string;
    apiKey?: string;
    settingsFile?: string;
    envFile?: string;
}
/**
 * Load saved agent settings from `.workflow/config.json` → `settings.agents[type]`.
 * Returns undefined if file is missing or agent type has no saved settings.
 */
export declare function loadDashboardAgentSettings(workflowRoot: string, agentType: AgentType): Promise<SavedAgentSettings | undefined>;
