import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import { type LlmConfig, type LlmCallOptions } from './llm.js';
import { type ToolSchema } from './tools.js';
import { type StreamEmitter } from './stream-json-emitter.js';
export interface AgentLoopParams {
    prompt: string;
    systemPrompt: string;
    client: OpenAI;
    llmConfig: LlmConfig;
    toolSchemas: ToolSchema[];
    maxTurns?: number;
    llmOptions?: LlmCallOptions;
    cwd: string;
    /** Protocol event sink (default: NDJSON on stdout — the standalone agent protocol) */
    emitter?: StreamEmitter;
    beforeTurn?: (ctx: {
        turn: number;
        messages: ChatCompletionMessageParam[];
    }) => Promise<void> | void;
    /** Ignored exact-path evidence files injected into the first Batch as direct Reads. */
    requiredInitialReads?: string[];
}
export interface AgentLoopResult {
    content: string;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    /** Set when the result content is an LLM API error, not a real answer */
    apiError?: boolean;
}
export declare function agentLoop(params: AgentLoopParams): Promise<AgentLoopResult>;
//# sourceMappingURL=agent-loop.d.ts.map