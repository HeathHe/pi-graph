function buildEmitter(sink) {
    return {
        init: () => sink({ type: 'init' }),
        message: (content, delta = false, role = 'assistant') => sink({ type: 'message', content, delta, role }),
        toolUse: (name, input, toolId) => sink({ type: 'tool_use', tool_name: name, parameters: input, tool_id: toolId }),
        toolResult: (toolId, content, isError = false) => sink({ type: 'tool_result', tool_id: toolId, content, is_error: isError }),
        result: (usage) => sink({ type: 'result', ...(usage ? { usage } : {}) }),
    };
}
/** NDJSON on stdout — the standalone agent binary protocol. */
export const stdoutEmitter = buildEmitter((event) => process.stdout.write(JSON.stringify(event) + '\n'));
/** Drops all events — for in-process embedding where the protocol stream is unused. */
export const silentEmitter = buildEmitter(() => { });
/** Cap for tool_result content stored in traces — keeps session files bounded. */
const TRACE_TOOL_RESULT_LIMIT = 2_000;
const TRACE_TOOL_RESULT_TAIL = 500;
/** Collects events into `trace` for session persistence; tool results are truncated. */
export function createTraceEmitter(trace) {
    return buildEmitter((event) => {
        if (event.type === 'tool_result' && typeof event.content === 'string'
            && event.content.length > TRACE_TOOL_RESULT_LIMIT) {
            const omitted = event.content.length - TRACE_TOOL_RESULT_LIMIT;
            const headLength = TRACE_TOOL_RESULT_LIMIT - TRACE_TOOL_RESULT_TAIL;
            event = {
                ...event,
                content: `${event.content.slice(0, headLength)}\n…[truncated ${omitted} chars; tail preserved]\n${event.content.slice(-TRACE_TOOL_RESULT_TAIL)}`,
            };
        }
        trace.push(event);
    });
}
//# sourceMappingURL=stream-json-emitter.js.map