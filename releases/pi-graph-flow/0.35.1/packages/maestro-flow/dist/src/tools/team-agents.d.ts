/**
 * Team Agents - MCP tools for agent lifecycle management via delegate broker
 *
 * Tools:
 * - team_spawn_agent:    Spawn a new agent (register session + create job)
 * - team_shutdown_agent: Cancel a running agent's delegate job
 * - team_remove_agent:   Remove agent from team config
 * - team_members:        List team members with live status from broker
 *
 * Storage: {run_dir}/work/team/members.json
 *
 * Integration:
 * - Delegate broker for job lifecycle (registerSession, publishEvent, requestCancel)
 * - Team config (members.json) for persistent member registry
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import type { AgentRepositoryContext } from '../../shared/agent-types.js';
export interface TeamMember {
    role: string;
    tool: string;
    prompt: string;
    job_id: string;
    exec_id: string;
    spawned_at: string;
    repository_context?: AgentRepositoryContext;
    target_repo_id?: string | null;
    work_dir?: string;
}
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
//# sourceMappingURL=team-agents.d.ts.map