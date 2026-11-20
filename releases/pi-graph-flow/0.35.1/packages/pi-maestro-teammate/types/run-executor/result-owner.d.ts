import type { Usage, AgentProgress } from "../shared/types.ts";
import type { JsonLineEvent } from "../runs/execution-infra.ts";
import type { InfraPorts } from "./lifecycle-contracts.ts";
export interface ResultReadyTurnContext {
    /** Tools that have started but not yet produced a result (in-flight). */
    inFlightToolCount?: number;
    /** Tools that have completed in this run so far. */
    completedToolCount?: number;
}
export interface StructuredOutputCandidate {
    value: unknown;
    toolCallId?: string;
}
export interface Utf8LineDecoder {
    write(chunk: Buffer): string[];
    end(): string[];
}
export type TranscriptEntry = {
    role: string;
    content: string;
};
export declare function createResultOwner(ports: InfraPorts): {
    STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTICS: {
        readonly agentEnd: "The teammate completed without calling structured_output with a schema-valid value.";
        readonly close: "The teammate exited without schema-valid structured_output.";
        readonly resultReadyGrace: "The teammate published a result but did not settle with schema-valid structured_output in time.";
    };
    STRUCTURED_OUTPUT_SETTLEMENT_DIAGNOSTIC_SET: Set<string>;
    isStructuredOutputSettlementDiagnostic: (content: string) => boolean;
    MODEL_FALLBACK_RESUME_PROMPT: string;
    correlationSessionDirectoryName: (correlationId: string) => string;
    extractTextContent: (event: JsonLineEvent) => string | undefined;
    isPiResultReadyTurn: (event: Record<string, unknown>, context?: ResultReadyTurnContext) => boolean;
    extractStructuredOutputCandidate: (event: Record<string, unknown>, schema: Record<string, unknown>) => StructuredOutputCandidate | undefined;
    extractValidatedStructuredOutput: (event: Record<string, unknown>, schema: Record<string, unknown>) => unknown | undefined;
    describeStructuredOutputValueValidationFailure: (value: unknown, schema: Record<string, unknown>) => string | undefined;
    describeStructuredOutputValidationFailure: (event: Record<string, unknown>, schema: Record<string, unknown>) => string | undefined;
    extractPiEventError: (event: Record<string, unknown>) => string | undefined;
    validateStructuredOutputValue: (value: unknown, schema: Record<string, unknown>) => boolean;
    EXECUTION_BUFFER_LIMITS: Readonly<{
        lineBytes: number;
        streamBytes: number;
        stderrBytes: number;
        toolItems: 10;
        toolNameBytes: 1024;
        transcriptMessages: 128;
        transcriptMessageBytes: number;
        transcriptBytes: number;
    }>;
    truncateUtf8Tail: (value: string, maxBytes: number) => string;
    truncateUtf8Head: (value: string, maxBytes: number) => string;
    appendUtf8Tail: (current: string, addition: string, maxBytes: number) => string;
    transcriptEntryBytes: WeakMap<TranscriptEntry, number>;
    transcriptTotals: WeakMap<object, {
        length: number;
        bytes: number;
    }>;
    entryBytes: (entry: TranscriptEntry) => number;
    transcriptTotalBytes: (messages: TranscriptEntry[]) => number;
    appendBoundedTranscriptMessage: (messages: Array<{
        role: string;
        content: string;
    }>, message: {
        role: string;
        content: string;
    }) => void;
    createUtf8LineDecoder: (maxBufferedBytes?: number, onOverflow?: (info: {
        receivedBytes: number;
        maxBytes: number;
        prefix: string;
    }) => void, onLine?: (line: string) => void) => Utf8LineDecoder;
    appendDistinctAssistantMessage: (messages: Array<{
        role: string;
        content: string;
    }>, content: string) => boolean;
    emptyUsage: () => Usage;
    usageNumber: (value: unknown) => number;
    setUsageSnapshot: (total: Usage, partial: Record<string, unknown>) => void;
    addUsageSnapshot: (total: Usage, partial: Record<string, unknown>) => void;
    resetUsage: (usage: Usage) => void;
    releasePublishedTurnHistory: (messages: Array<{
        role: string;
        content: string;
    }>, progress: AgentProgress, usage: Usage) => void;
};
