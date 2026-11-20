/**
 * Built-in classification domains owned by the teammate package.
 *
 * - `retry-error`: provider failure → RetryErrorKind. The L0 rules are the
 *   existing `classifyRetryErrorDetailed` chain; JEV's role is judging the
 *   default (unrecognized) branch. Shadow-only in this increment — the sync
 *   retry boundary cannot await an HTTP call, so adjudication is deferred
 *   until a shadow corpus validates agreement.
 * - `file-value`: new-context handoff file annotation →
 *   required|conditional|skip|unknown. JEV-primary (no rule opinion); the
 *   `unknown` fallback keeps unannotated references honest.
 */
import { type RetryErrorKind } from "../runs/retry.ts";
import type { ClassifyDomain } from "./types.ts";
export interface RetryErrorInput {
    message?: string;
    status?: number;
}
export declare const retryErrorDomain: ClassifyDomain<RetryErrorKind, RetryErrorInput>;
export type FileValueLabel = "required" | "conditional" | "skip" | "unknown";
export interface FileValueInput {
    /** The referenced path/URI being annotated. */
    path: string;
    /** The next action the handoff recommends (context for relevance). */
    nextAction?: string;
    /** Why the annotator thought it matters, when present. */
    reason?: string;
    /** Prior role: modified | read | referenced, when known. */
    role?: string;
}
export declare const fileValueDomain: ClassifyDomain<FileValueLabel, FileValueInput>;
/** Register the teammate-owned domains (idempotent — re-registering overwrites). */
export declare function registerBuiltinClassifyDomains(): void;
