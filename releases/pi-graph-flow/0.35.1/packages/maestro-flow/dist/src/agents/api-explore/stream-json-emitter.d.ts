export interface StreamJsonUsage {
    input_tokens: number;
    output_tokens: number;
}
/** One protocol event (init | message | tool_use | tool_result | result). */
export type StreamEvent = Record<string, unknown> & {
    type: string;
};
/** Receives every protocol event emitted by the agent loop. */
export interface StreamEmitter {
    init(): void;
    message(content: string, delta?: boolean, role?: 'assistant' | 'user'): void;
    toolUse(name: string, input: Record<string, unknown>, toolId: string): void;
    toolResult(toolId: string, content: string, isError?: boolean): void;
    result(usage?: StreamJsonUsage): void;
}
/** NDJSON on stdout — the standalone agent binary protocol. */
export declare const stdoutEmitter: StreamEmitter;
/** Drops all events — for in-process embedding where the protocol stream is unused. */
export declare const silentEmitter: StreamEmitter;
/** Collects events into `trace` for session persistence; tool results are truncated. */
export declare function createTraceEmitter(trace: StreamEvent[]): StreamEmitter;
//# sourceMappingURL=stream-json-emitter.d.ts.map