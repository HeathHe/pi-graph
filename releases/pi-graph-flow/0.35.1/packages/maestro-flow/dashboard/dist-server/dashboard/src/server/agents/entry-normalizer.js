// ---------------------------------------------------------------------------
// EntryNormalizer — static factory for creating NormalizedEntry instances
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
/** Factory for creating NormalizedEntry instances with consistent base fields */
export class EntryNormalizer {
    static partialCounter = 0;
    constructor() {
        // Static-only class
    }
    static userMessage(processId, content) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'user_message',
            content,
        };
    }
    static assistantMessage(processId, content, partial) {
        return {
            id: partial ? `p-${processId}-${++EntryNormalizer.partialCounter}` : randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'assistant_message',
            content,
            partial,
        };
    }
    static thinking(processId, content) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'thinking',
            content,
        };
    }
    static toolUse(processId, name, input, status, result) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'tool_use',
            name,
            input,
            status,
            result,
        };
    }
    static fileChange(processId, path, action, diff) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'file_change',
            path,
            action,
            diff,
        };
    }
    static commandExec(processId, command, exitCode, output) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'command_exec',
            command,
            exitCode,
            output,
        };
    }
    static approvalRequest(processId, toolName, toolInput, requestId) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'approval_request',
            toolName,
            toolInput,
            requestId,
        };
    }
    static approvalResponse(processId, requestId, allowed) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'approval_response',
            requestId,
            allowed,
        };
    }
    static error(processId, message, code) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'error',
            message,
            code,
        };
    }
    static statusChange(processId, status, reason) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'status_change',
            status,
            reason,
        };
    }
    static tokenUsage(processId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) {
        return {
            id: randomUUID(),
            processId,
            timestamp: new Date().toISOString(),
            type: 'token_usage',
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
        };
    }
}
//# sourceMappingURL=entry-normalizer.js.map