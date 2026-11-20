// ---------------------------------------------------------------------------
// SdkMessageTranslator — maps Agent SDK SDKMessage stream to NormalizedEntry[]
// ---------------------------------------------------------------------------
// Handles 13 SDKMessage types from @anthropic-ai/claude-agent-sdk:
//   Active (6): system, assistant, user, result, tool_progress, rate_limit_event
//   Skipped (7): compact_boundary, user_message_replay, auth_status, hook_response,
//                prompt_suggestion, status, partial_assistant (handled if encountered)
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
/**
 * Translates Agent SDK messages into the maestro NormalizedEntry system.
 *
 * The SDK emits typed messages via an async iterable from `query()`.
 * This class maintains state for correlating tool_use blocks with their
 * subsequent tool_use_result messages.
 */
export class SdkMessageTranslator {
    processId;
    /** Tracks pending tool_use blocks awaiting their result via tool_use_id */
    pendingToolUses = new Map();
    /** Whether any assistant_message text was already emitted (to avoid duplicate from result) */
    hasEmittedAssistantText = false;
    constructor(processId) {
        this.processId = processId;
    }
    // -------------------------------------------------------------------------
    // Public API
    // -------------------------------------------------------------------------
    /**
     * Translate a single SDKMessage into zero or more NormalizedEntry instances.
     * Unknown or internal-only message types are silently skipped.
     */
    translate(msg) {
        const entries = [];
        switch (msg.type) {
            case 'system':
                if (msg.subtype === 'init') {
                    entries.push({ ...this.base(), type: 'status_change', status: 'running' });
                }
                break;
            case 'assistant':
                entries.push(...this.translateAssistant(msg));
                break;
            case 'user':
                if (msg.tool_use_result) {
                    entries.push(...this.translateToolResult(msg));
                }
                else if (!msg.isSynthetic) {
                    entries.push({
                        ...this.base(),
                        type: 'user_message',
                        content: this.extractText(msg.message),
                    });
                }
                break;
            case 'result':
                entries.push(...this.translateResult(msg));
                break;
            case 'tool_progress':
                entries.push({
                    ...this.base(),
                    type: 'tool_use',
                    name: msg.tool_name ?? 'unknown',
                    input: {},
                    status: 'running',
                });
                break;
            case 'rate_limit_event':
                entries.push({
                    ...this.base(),
                    type: 'error',
                    message: 'Rate limit reached',
                    code: 'RATE_LIMIT',
                });
                break;
            // Skipped types — internal SDK markers, no user-visible output
            case 'compact_boundary':
            case 'user_message_replay':
            case 'auth_status':
            case 'hook_response':
            case 'prompt_suggestion':
            case 'status':
                break;
            default:
                // Unknown message type — skip silently
                break;
        }
        return entries;
    }
    // -------------------------------------------------------------------------
    // Private translation methods
    // -------------------------------------------------------------------------
    translateAssistant(msg) {
        const entries = [];
        if (msg.error) {
            entries.push({
                ...this.base(),
                type: 'error',
                message: `Assistant error: ${msg.error}`,
            });
            return entries;
        }
        const message = msg.message;
        const content = (message?.content ?? []);
        for (const block of content) {
            switch (block.type) {
                case 'thinking':
                    entries.push({
                        ...this.base(),
                        type: 'thinking',
                        content: block.thinking ?? '',
                    });
                    break;
                case 'text':
                    entries.push({
                        ...this.base(),
                        type: 'assistant_message',
                        content: block.text ?? '',
                        partial: false,
                    });
                    this.hasEmittedAssistantText = true;
                    break;
                case 'tool_use': {
                    const toolId = block.id;
                    const toolName = block.name ?? 'unknown';
                    const toolInput = block.input ?? {};
                    this.pendingToolUses.set(toolId, { name: toolName, input: toolInput });
                    entries.push(this.toolUseToEntry(toolName, toolInput, 'running'));
                    break;
                }
            }
        }
        return entries;
    }
    translateToolResult(msg) {
        const result = msg.tool_use_result;
        if (!result)
            return [];
        const toolUseId = result.tool_use_id;
        const pending = this.pendingToolUses.get(toolUseId);
        if (!pending)
            return [];
        const isError = result.is_error;
        const output = typeof result.output === 'string'
            ? result.output
            : JSON.stringify(result.output);
        const entry = this.toolUseToEntry(pending.name, pending.input, isError ? 'failed' : 'completed', output);
        this.pendingToolUses.delete(toolUseId);
        return [entry];
    }
    /**
     * Routes tool usage to the appropriate NormalizedEntry type.
     * - Edit -> file_change (modify)
     * - Write -> file_change (create)
     * - Bash -> command_exec
     * - Others -> generic tool_use
     */
    toolUseToEntry(toolName, input, status, result) {
        switch (toolName) {
            case 'Edit':
                return {
                    ...this.base(),
                    type: 'file_change',
                    path: input.file_path ?? '',
                    action: 'modify',
                    diff: result,
                };
            case 'Write':
                return {
                    ...this.base(),
                    type: 'file_change',
                    path: input.file_path ?? '',
                    action: 'create',
                };
            case 'Bash':
                return {
                    ...this.base(),
                    type: 'command_exec',
                    command: input.command ?? '',
                    output: result,
                    exitCode: status === 'failed' ? 1 : (status === 'completed' ? 0 : undefined),
                };
            default:
                return {
                    ...this.base(),
                    type: 'tool_use',
                    name: toolName,
                    input,
                    status,
                    result,
                };
        }
    }
    translateResult(msg) {
        const entries = [];
        if (msg.subtype === 'success') {
            // Only emit result text if no assistant_message was already emitted
            // (the SDK sends the same text in both 'assistant' and 'result' messages)
            if (msg.result && !this.hasEmittedAssistantText) {
                entries.push({
                    ...this.base(),
                    type: 'assistant_message',
                    content: msg.result,
                    partial: false,
                });
            }
            const usage = msg.usage;
            entries.push({
                ...this.base(),
                type: 'token_usage',
                inputTokens: usage?.input_tokens ?? 0,
                outputTokens: usage?.output_tokens ?? 0,
                cacheReadTokens: usage?.cache_read_input_tokens,
                cacheWriteTokens: usage?.cache_creation_input_tokens,
            });
            entries.push({
                ...this.base(),
                type: 'status_change',
                status: 'stopped',
            });
        }
        else {
            entries.push({
                ...this.base(),
                type: 'error',
                message: msg.error ?? `Agent ended: ${msg.subtype}`,
                code: msg.subtype,
            });
            entries.push({
                ...this.base(),
                type: 'status_change',
                status: 'error',
                reason: msg.subtype,
            });
        }
        return entries;
    }
    /**
     * Extract text content from a message object.
     * Handles both string content and content block arrays.
     */
    extractText(message) {
        if (!message || typeof message !== 'object')
            return '';
        const msg = message;
        if (!msg.content)
            return '';
        if (typeof msg.content === 'string')
            return msg.content;
        if (!Array.isArray(msg.content))
            return '';
        return msg.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    base() {
        return {
            id: randomUUID(),
            processId: this.processId,
            timestamp: new Date().toISOString(),
        };
    }
}
//# sourceMappingURL=sdk-message-translator.js.map