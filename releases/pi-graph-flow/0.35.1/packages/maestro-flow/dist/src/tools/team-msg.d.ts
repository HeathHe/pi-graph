/**
 * Team Message Bus - JSONL-based persistent message log for Agent Teams
 *
 * Operations:
 * - log:            Append a message (to defaults to "coordinator", summary auto-generated if omitted)
 * - read:           Read message(s) by ID
 * - list:           List recent messages with optional filters (from/to/type/last N)
 * - status:         Summarize team member activity from message history
 * - delete:         Delete a specific message by ID
 * - clear:          Clear all messages for a team
 * - broadcast:      Log a message with to="all"
 * - get_state:      Read role state from meta.json
 * - read_mailbox:   Read unread messages for a role and mark them as delivered
 * - mailbox_status: Return counts of pending/notified/delivered/failed per role
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
import { type ClassifyTeamSessionOptions, type TeamSessionClassification, type TeamSessionLifecycle } from '../team/session-lifecycle.js';
export interface TeamMeta {
    status: TeamSessionLifecycle;
    health?: TeamSessionClassification['health'];
    cleanup_eligible?: boolean;
    created_at: string;
    updated_at: string;
    archived_at?: string;
    pipeline_mode?: string;
    pipeline_stages?: string[];
    team_name?: string;
    task_description?: string;
    roles?: string[];
    role_state?: Record<string, Record<string, unknown>>;
}
export declare function getMetaPath(team: string): string;
export declare function readTeamMeta(team: string): TeamMeta | null;
export declare function writeTeamMeta(team: string, meta: TeamMeta): void;
export declare function inferTeamStatus(team: string): TeamMeta['status'];
export declare function getEffectiveTeamMeta(team: string): TeamMeta;
export interface StoredTeamSessionClassificationOptions extends Partial<ClassifyTeamSessionOptions> {
    projectRoot?: string;
    liveBrokerMembers?: number;
    livenessKnown?: boolean;
}
export interface StoredTeamSessionLocation {
    stateDir: string;
    runRootDir?: string;
}
/** Reconcile canonical Run, sidecar, message, task, and legacy clocks. */
export declare function readStoredTeamSessionClassification(team: string, options?: StoredTeamSessionClassificationOptions): TeamSessionClassification;
export declare function readStoredTeamSessionClassificationAt(location: StoredTeamSessionLocation, options?: Omit<StoredTeamSessionClassificationOptions, 'projectRoot'>): TeamSessionClassification;
/** Dispatch status lifecycle: pending -> notified -> delivered (or failed) */
export type DispatchStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export interface TeamMessage {
    id: string;
    ts: string;
    from: string;
    to: string;
    type: string;
    summary: string;
    data?: Record<string, unknown>;
    dispatch_status?: DispatchStatus;
    delivery_method?: string;
    notified_at?: string;
    delivered_at?: string;
    failed_at?: string;
}
export interface StatusEntry {
    member: string;
    lastSeen: string;
    lastAction: string;
    messageCount: number;
}
export declare const schema: ToolSchema;
export declare function getLogDir(sessionId: string): string;
export declare function getLogDirWithFallback(sessionId: string): string;
export declare function readAllMessages(teamId: string): TeamMessage[];
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
//# sourceMappingURL=team-msg.d.ts.map