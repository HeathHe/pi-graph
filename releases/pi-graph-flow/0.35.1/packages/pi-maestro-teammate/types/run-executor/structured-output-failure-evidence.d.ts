/** Evidence describes bytes from a rejected attempt; it grants no completion authority. */
export type StructuredOutputFailureEvidence = {
    kind: "structured-output-failure";
    correlationId: string;
    complete: true;
    path: string;
    sha256: string;
    bytes: number;
} | {
    kind: "structured-output-failure";
    correlationId: string;
    complete: false;
    bytes: number | "unknown";
    reason: "limit-exceeded" | "read-failed" | "evidence-write-failed";
};
/** Persist bounded original bytes independently of prompt/transcript truncation. */
export declare function preserveStructuredOutputFailure(correlationId: string, raw: Buffer | undefined, incomplete?: {
    bytes: number | "unknown";
    reason: "limit-exceeded" | "read-failed";
}): StructuredOutputFailureEvidence;
