import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';
export type LlmFormat = 'openai' | 'anthropic' | 'openai-responses';
export interface LlmToolCall {
    id: string;
    name: string;
    arguments: string;
}
export interface LlmResponse {
    content: string | null;
    toolCalls: LlmToolCall[];
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    stopReason?: string;
}
export interface LlmConfig {
    model: string;
    baseUrl: string;
    apiKey: string;
    format?: LlmFormat;
    /** Model-specific extra body params (e.g. Qwen enable_thinking) */
    extraBody?: Record<string, unknown>;
    /** Proxy URL — when set, HTTP requests use undici ProxyAgent instead of direct connection */
    proxyUrl?: string;
}
export interface LlmCallOptions {
    temperature?: number;
    maxTokens?: number;
}
/**
 * Return true only for connection-level failures where retrying without the
 * configured proxy is safe. HTTP/API errors (for example 401 or 429) must not
 * be retried because the provider may already have processed the request.
 */
export declare function isRetryableTransportError(error: unknown): boolean;
/**
 * Execute an HTTP route and retry it directly once when a configured proxy
 * fails at the transport layer. This covers the race where the proxy stops
 * after the command-level reachability probe succeeds.
 */
export declare function withDirectProxyFallback<T>(config: LlmConfig, request: (effectiveConfig: LlmConfig) => Promise<T>): Promise<T>;
/**
 * Fast connectivity probe — GET /models with a short timeout.
 * Returns true if the endpoint responds (any HTTP status), false on timeout/connection error.
 */
export declare function probeEndpoint(config: LlmConfig, timeoutMs?: number): Promise<boolean>;
export declare function createClient(params: LlmConfig): {
    client: OpenAI;
    config: LlmConfig;
};
export declare function callLlm(client: OpenAI, config: LlmConfig, messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[], options?: LlmCallOptions): Promise<LlmResponse>;
//# sourceMappingURL=llm.d.ts.map