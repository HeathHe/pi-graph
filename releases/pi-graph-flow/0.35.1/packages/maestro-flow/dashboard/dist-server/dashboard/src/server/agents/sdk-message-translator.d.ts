import type { NormalizedEntry } from '../../shared/agent-types.js';
/**
 * Translates Agent SDK messages into the maestro NormalizedEntry system.
 *
 * The SDK emits typed messages via an async iterable from `query()`.
 * This class maintains state for correlating tool_use blocks with their
 * subsequent tool_use_result messages.
 */
export declare class SdkMessageTranslator {
    private readonly processId;
    /** Tracks pending tool_use blocks awaiting their result via tool_use_id */
    private readonly pendingToolUses;
    /** Whether any assistant_message text was already emitted (to avoid duplicate from result) */
    private hasEmittedAssistantText;
    constructor(processId: string);
    /**
     * Translate a single SDKMessage into zero or more NormalizedEntry instances.
     * Unknown or internal-only message types are silently skipped.
     */
    translate(msg: Record<string, unknown>): NormalizedEntry[];
    private translateAssistant;
    private translateToolResult;
    /**
     * Routes tool usage to the appropriate NormalizedEntry type.
     * - Edit -> file_change (modify)
     * - Write -> file_change (create)
     * - Bash -> command_exec
     * - Others -> generic tool_use
     */
    private toolUseToEntry;
    private translateResult;
    /**
     * Extract text content from a message object.
     * Handles both string content and content block arrays.
     */
    private extractText;
    private base;
}
