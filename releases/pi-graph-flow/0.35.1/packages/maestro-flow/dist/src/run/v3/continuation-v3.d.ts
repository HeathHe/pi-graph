import { z } from 'zod';
export declare const v3ContinuationOperationSchema: z.ZodEnum<{
    check: "check";
    next: "next";
    complete: "complete";
    brief: "brief";
    "session-complete": "session-complete";
    "run-decide": "run-decide";
}>;
export type V3ContinuationOperation = z.infer<typeof v3ContinuationOperationSchema>;
export declare const v3RequiredCallerFieldSchema: z.ZodEnum<{
    actor: "actor";
    reason: "reason";
    request_id: "request_id";
    verdict: "verdict";
    participant: "participant";
}>;
export type V3RequiredCallerField = z.infer<typeof v3RequiredCallerFieldSchema>;
export declare const v3ContinuationMetadataSchema: z.ZodObject<{
    operation: z.ZodEnum<{
        check: "check";
        next: "next";
        complete: "complete";
        brief: "brief";
        "session-complete": "session-complete";
        "run-decide": "run-decide";
    }>;
    locator: z.ZodObject<{
        session_id: z.ZodString;
        run_id: z.ZodNullable<z.ZodString>;
    }, z.core.$strict>;
    revision_requirements: z.ZodObject<{
        expected_orchestration_revision: z.ZodNullable<z.ZodNumber>;
        expected_run_revision: z.ZodNullable<z.ZodNumber>;
    }, z.core.$strict>;
    required_caller_fields: z.ZodArray<z.ZodEnum<{
        actor: "actor";
        reason: "reason";
        request_id: "request_id";
        verdict: "verdict";
        participant: "participant";
    }>>;
}, z.core.$strict>;
export type V3ContinuationMetadata = z.infer<typeof v3ContinuationMetadataSchema>;
export declare const v3TaskContractSchema: z.ZodObject<{
    command: z.ZodString;
    args: z.ZodArray<z.ZodString>;
    goal: z.ZodNullable<z.ZodString>;
    input_refs: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type V3TaskContract = Readonly<{
    command: string;
    args: readonly string[];
    goal: string | null;
    input_refs: readonly string[];
}>;
export interface V3NextContract {
    next: {
        suggest_only: true;
        command: string;
        reason: string;
    };
    continuation: V3ContinuationMetadata;
}
export declare function v3BriefCommand(sessionId: string, runId: string): string;
export declare function v3CompleteNext(input: {
    sessionId: string;
    runId: string;
    orchestrationRevision: number;
    runRevision: number;
    reason: string;
}): V3NextContract;
export declare function v3RunNext(input: {
    sessionId: string;
    orchestrationRevision: number;
    reason: string;
}): V3NextContract;
export declare function v3SessionCompleteNext(input: {
    sessionId: string;
    orchestrationRevision: number;
    reason: string;
}): V3NextContract;
export declare function v3DecideNext(input: {
    sessionId: string;
    pointId: string;
    orchestrationRevision: number;
    reason: string;
}): V3NextContract;
export declare function v3CheckNext(input: {
    sessionId: string;
    runId: string;
    reason: string;
}): V3NextContract;
//# sourceMappingURL=continuation-v3.d.ts.map