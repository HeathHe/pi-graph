/**
 * Team Mailbox - MCP tools for agent-to-agent messaging with delivery tracking
 *
 * Tools:
 * - team_send_message:    Send a message to a team role (persists to JSONL + broker inject)
 * - team_read_mailbox:    Read unread messages for a role, mark as delivered
 * - team_mailbox_status:  Per-role unread/pending/delivered counts
 *
 * Storage: {run_dir}/work/team/.msg/mailbox.jsonl
 *
 * Integration points for TASK-001 (team-msg dispatch upgrade):
 * - opReadMailbox: reads messages addressed to a role
 * - opGetMailboxStatus: aggregates per-role delivery counts
 * - delivery_method field on opLog messages
 */
import type { ToolSchema, CcwToolResult } from '../types/tool-schema.js';
export type DeliveryMethod = 'inject' | 'poll' | 'broadcast';
export type DeliveryStatus = 'pending' | 'notified' | 'delivered' | 'failed';
export interface MailboxMessage {
    id: string;
    ts: string;
    from: string;
    to: string;
    type: string;
    message: string;
    delivery_method: DeliveryMethod;
    delivery_status: DeliveryStatus;
    delivered_at?: string;
    data?: Record<string, unknown>;
}
export interface MailboxRoleStatus {
    role: string;
    pending: number;
    notified: number;
    delivered: number;
    failed: number;
}
export declare const schema: ToolSchema;
export declare function handler(params: Record<string, unknown>): Promise<CcwToolResult>;
//# sourceMappingURL=team-mailbox.d.ts.map