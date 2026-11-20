/**
 * Team Task MCP Tools - Agent-facing task management wrapping CollabTask.
 *
 * Exposes CRUD operations over the CollabTask system for agent consumption
 * via MCP. Tasks are scoped to a team session_id under the agent pipeline
 * namespace ({run_dir}/work/team/tasks/) to avoid collision with
 * the human collaboration domain (.workflow/collab/tasks/).
 *
 * Reuses the CollabTask state machine from team-tasks.ts:
 *   open -> assigned -> in_progress -> pending_review -> done -> closed
 *   closed -> open (reopen)
 *
 * Operations:
 * - create: Create a new task (title, description, owner, priority)
 * - update: Update task fields (task_id, status, owner, description)
 * - list:   List tasks with optional filters (session_id, status, owner)
 * - get:    Get a single task by ID
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import type { CollabTask } from './team-tasks.js';
/** Agent-scoped task: wraps CollabTask with a session namespace. */
export interface AgentTask extends CollabTask {
    session_id: string;
}
export interface TeamTaskActivityEvidence {
    nonTerminalCount: number;
    latestUpdatedAt?: string;
    known: boolean;
}
/**
 * Read task activity without creating directories or mutating task state.
 * This is the adapter boundary consumed by lifecycle classification.
 */
export declare function readTeamTaskActivityEvidence(sessionId: string, projectRoot?: string): TeamTaskActivityEvidence;
export declare function readTeamTaskActivityEvidenceAt(stateDir: string): TeamTaskActivityEvidence;
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
