import { callLlm } from './llm.js';
import { executeToolAsync } from './tools.js';
import { stdoutEmitter } from './stream-json-emitter.js';
import { DEFAULT_EXPLORE_MAX_TURNS } from './config.js';
export async function agentLoop(params) {
    const { prompt, systemPrompt, client, llmConfig, toolSchemas, cwd } = params;
    const maxTurns = params.maxTurns ?? DEFAULT_EXPLORE_MAX_TURNS;
    const emitter = params.emitter ?? stdoutEmitter;
    emitter.init();
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
    ];
    const tools = toolSchemas;
    let totalInput = 0;
    let totalOutput = 0;
    let turn = 0;
    let toolRounds = 0;
    let toolCalled = false;
    let pendingContent = '';
    let finalAnswerRequested = false;
    let efficiencyCheckpointRequested = false;
    while (true) {
        turn++;
        await params.beforeTurn?.({ turn, messages });
        const forceFinalAnswer = tools.length > 0 && maxTurns > 0 && toolRounds >= maxTurns;
        if (forceFinalAnswer && !finalAnswerRequested && !pendingContent) {
            messages.push({
                role: 'user',
                content: `You have completed ${toolRounds} Batch rounds. Tools are now disabled. Return the final answer using the evidence already gathered.`,
            });
            finalAnswerRequested = true;
        }
        if (tools.length > 0
            && toolRounds >= 2
            && toolRounds < maxTurns
            && !efficiencyCheckpointRequested
            && !pendingContent) {
            messages.push({
                role: 'user',
                content: 'Efficiency checkpoint: compare the gathered evidence with every EXPECTED item. If all items are covered, return the final answer now. Call Batch again only for a specific missing evidence item, and include all commands for that gap in one Batch.',
            });
            efficiencyCheckpointRequested = true;
        }
        let response;
        try {
            const messagesForCall = forceFinalAnswer
                ? compactMessagesForFinalAnswer(messages)
                : messages;
            response = await callLlm(client, llmConfig, messagesForCall, forceFinalAnswer ? [] : tools, params.llmOptions);
        }
        catch (err) {
            const errMsg = `LLM API error: ${err instanceof Error ? err.message : String(err)}`;
            emitter.message(errMsg);
            emitter.result({ input_tokens: totalInput, output_tokens: totalOutput });
            return { content: errMsg, usage: { inputTokens: totalInput, outputTokens: totalOutput }, apiError: true };
        }
        totalInput += response.usage.inputTokens;
        totalOutput += response.usage.outputTokens;
        const toolCalls = normalizeBatchToolCalls(response.toolCalls, toolRounds === 0 ? params.requiredInitialReads : undefined);
        if (toolCalls.length > 0) {
            if (forceFinalAnswer) {
                const content = response.content?.trim()
                    || 'Tool round budget exhausted before the model produced a final answer.';
                emitter.message(content);
                emitter.result({ input_tokens: totalInput, output_tokens: totalOutput });
                return { content, usage: { inputTokens: totalInput, outputTokens: totalOutput } };
            }
            pendingContent = '';
            toolCalled = true;
            toolRounds++;
            if (response.content) {
                emitter.message(response.content, true);
            }
            messages.push({
                role: 'assistant',
                content: response.content,
                tool_calls: toolCalls.map(tc => ({
                    id: tc.id,
                    type: 'function',
                    function: { name: tc.name, arguments: tc.arguments },
                })),
            });
            for (const tc of toolCalls) {
                emitter.toolUse(tc.name, safeParseJson(tc.arguments), tc.id);
            }
            const results = await Promise.all(toolCalls.map(async (tc) => {
                try {
                    return { id: tc.id, result: await executeToolAsync(tc.name, tc.arguments, cwd), error: false };
                }
                catch (err) {
                    return { id: tc.id, result: `Error: ${err instanceof Error ? err.message : String(err)}`, error: true };
                }
            }));
            for (const r of results) {
                emitter.toolResult(r.id, r.result, r.error);
                messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
            }
        }
        else if (tools.length > 0 && !toolCalled && turn <= 2) {
            // Anti-hallucination: force tool use before answering
            messages.push({
                role: 'assistant',
                content: response.content,
            });
            messages.push({
                role: 'user',
                content: 'You must call Batch before answering. Put all independent evidence commands into one Batch call and directly Read any required exact files.',
            });
        }
        else {
            const text = response.content ?? '';
            const truncated = response.stopReason === 'length' || response.stopReason === 'max_tokens';
            if (truncated && text) {
                pendingContent += text;
                emitter.message(text, true);
                messages.push({ role: 'assistant', content: text });
                messages.push({ role: 'user', content: 'Continue.' });
                continue;
            }
            const content = pendingContent + text;
            pendingContent = '';
            emitter.message(text);
            emitter.result({ input_tokens: totalInput, output_tokens: totalOutput });
            return { content, usage: { inputTokens: totalInput, outputTokens: totalOutput } };
        }
    }
}
/**
 * Some OpenAI-compatible endpoints occasionally emit undeclared direct Search
 * or Read calls, or multiple Batch calls in one assistant turn. Collapse all
 * supported commands into the single declared Batch call so local concurrency,
 * result budgets, and round accounting remain authoritative.
 */
function normalizeBatchToolCalls(toolCalls, requiredReads = []) {
    if (toolCalls.length === 0)
        return toolCalls;
    if (toolCalls.length === 1 && toolCalls[0].name === 'Batch' && requiredReads.length === 0)
        return toolCalls;
    const commands = requiredReads.map(filePath => ({
        type: 'Read',
        file_path: filePath,
    }));
    for (const toolCall of toolCalls) {
        const args = safeParseJson(toolCall.arguments);
        if (toolCall.name === 'Batch') {
            if (!Array.isArray(args.commands))
                return toolCalls;
            for (const command of args.commands) {
                if (!command || typeof command !== 'object' || Array.isArray(command))
                    return toolCalls;
                commands.push(command);
            }
            continue;
        }
        if (toolCall.name === 'Search' || toolCall.name === 'Read') {
            commands.push({ ...args, type: toolCall.name });
            continue;
        }
        return toolCalls;
    }
    if (commands.length === 0)
        return toolCalls;
    const seenReads = new Set();
    const deduplicatedCommands = commands.filter((command) => {
        if (command.type !== 'Read' || typeof command.file_path !== 'string')
            return true;
        const key = command.file_path.replace(/\\/g, '/').toLowerCase();
        if (seenReads.has(key))
            return false;
        seenReads.add(key);
        return true;
    });
    return [{
            id: toolCalls[0].id,
            name: 'Batch',
            arguments: JSON.stringify({ commands: deduplicatedCommands }),
        }];
}
const FINAL_CONTEXT_TOOL_ROUNDS = 3;
function compactMessagesForFinalAnswer(messages) {
    const roundStarts = [];
    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        if (message.role !== 'assistant' || !('tool_calls' in message))
            continue;
        if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
            roundStarts.push(index);
        }
    }
    if (roundStarts.length <= FINAL_CONTEXT_TOOL_ROUNDS)
        return messages;
    const tailStart = roundStarts[roundStarts.length - FINAL_CONTEXT_TOOL_ROUNDS];
    return [
        ...messages.slice(0, 2),
        {
            role: 'user',
            content: `[Earlier Batch rounds omitted to reduce payload. Use the retained ${FINAL_CONTEXT_TOOL_ROUNDS} most recent evidence rounds for the final answer.]`,
        },
        ...messages.slice(tailStart),
    ];
}
function safeParseJson(str) {
    try {
        return JSON.parse(str);
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=agent-loop.js.map