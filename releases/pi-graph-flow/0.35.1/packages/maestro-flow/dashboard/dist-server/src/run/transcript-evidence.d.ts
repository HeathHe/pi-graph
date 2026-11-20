import { z } from 'zod';
/** Per-fragment quote limit (bytes, UTF-8). Quotes above this are rejected. */
export declare const TRANSCRIPT_EVIDENCE_MAX_BYTES: number;
/** Absolute hard cap (bytes, UTF-8). Quotes above this are rejected. */
export declare const TRANSCRIPT_EVIDENCE_HARD_CAP_BYTES: number;
/** K13 input descriptor contract (aligned with the Pi plugin side, immutable). */
export declare const transcriptQuoteInputSchema: z.ZodObject<{
    host_kind: z.ZodString;
    host_session_id: z.ZodString;
    entry_id: z.ZodString;
    quote: z.ZodString;
}, z.core.$strict>;
/** Snapshot sidecar under sessions/<sid>/transcript-evidence/<sha256>-<locator>.json. */
export declare const transcriptEvidenceSnapshotSchema: z.ZodObject<{
    schema_version: z.ZodLiteral<"transcript-evidence/1.0">;
    sha256: z.ZodString;
    normalized_sha256: z.ZodString;
    host_kind: z.ZodString;
    host_session_id: z.ZodString;
    entry_id: z.ZodString;
    captured_at: z.ZodString;
    quote: z.ZodString;
}, z.core.$strict>;
export type TranscriptEvidenceSnapshot = z.infer<typeof transcriptEvidenceSnapshotSchema>;
/**
 * Canonicalize a quote fragment: CRLF/CR line endings to LF, then Unicode NFC.
 * The stored snapshot carries this normalized form.
 */
export declare function normalizeQuote(quote: string): string;
/**
 * sha256 over the raw UTF-8 bytes of the quote — the content address that
 * determines the snapshot file name and the K12 URI tail ([:16]).
 */
export declare function quoteSha256(quote: string): string;
export interface TranscriptEvidenceStoreResult {
    sha256: string;
    path: string;
    reused: boolean;
}
export interface TranscriptQuoteHost {
    host_kind: string;
    host_session_id: string;
    entry_id: string;
}
/**
 * K13 — content-addressed snapshot write under the SessionStore transaction.
 * Quote hash identifies the content; a locator hash suffix separates identical
 * quotes observed in different windows/entries so independent evidence roots
 * do not collide. The same quote+locator pair remains idempotent.
 */
export declare function storeTranscriptEvidence(projectRoot: string, sessionId: string, quote: string, host: TranscriptQuoteHost): TranscriptEvidenceStoreResult;
/**
 * K12 — transcript anchor URI string, appendable into evidence_refs as-is.
 * Tail is the first 16 hex chars of the snapshot sha256. hostKind/
 * hostSessionId/entryId must be ':'-free and control-char-free so the URI
 * round-trips through parseTranscriptUri unchanged (K16 concern fix).
 */
export declare function buildTranscriptUri(hostKind: string, hostSessionId: string, entryId: string, sha256: string): string;
export interface ParsedTranscriptUri {
    hostKind: string;
    hostSessionId: string;
    entryId: string;
    sha256Prefix: string;
}
/** Parse a K12 anchor URI; null for non-transcript refs or malformed values. */
export declare function parseTranscriptUri(ref: string): ParsedTranscriptUri | null;
export interface TranscriptEvidenceRender {
    present: boolean;
    summary: string;
}
/**
 * K16 — desensitized review rendering for a transcript anchor URI.
 * sessionId scopes the lookup to one governance Session's snapshot directory;
 * when omitted every Session under .workflow/sessions is scanned (best effort —
 * the URI alone cannot pin the governance Session; host ids are mapping keys
 * only, iron rule 7). Rendering always carries the [untrusted] marker.
 *
 * Iron-rule-10 boundary (GPT final review fix): the summary NEVER contains the
 * quote text — review output is agent-visible, so quote content would leak
 * into an LLM tool context. Only the snapshot state (present/absent/integrity
 * failed) is rendered; full quote display is deferred to an explicit
 * human-only evidence-show surface (Phase 2B / evidence capsule).
 */
export declare function renderTranscriptEvidence(ref: string, projectRoot: string, sessionId?: string): TranscriptEvidenceRender;
