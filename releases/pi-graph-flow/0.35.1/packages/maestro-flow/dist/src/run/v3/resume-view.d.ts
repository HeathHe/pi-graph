import { type ResumeMapV1 } from '../protocol-schemas.js';
import { type RunV30, type SessionStateV30 } from '../schemas.js';
export declare const RESUME_MAP_MAX_UTF8_BYTES = 2048;
type ResumeMapBody = Omit<ResumeMapV1, 'fingerprint'>;
type PendingPublication = ResumeMapV1['pendingPublications'][number];
type NextAction = ResumeMapV1['nextActions'][number];
export interface ResumeMapProjectionInput {
    session: SessionStateV30;
    runs: readonly RunV30[];
    blockingGates: readonly string[];
    openDecisions: readonly string[];
    pendingPublications: readonly PendingPublication[];
    nextActions: readonly NextAction[];
}
export declare class ResumeMapProjectionError extends Error {
    constructor(message: string);
}
/** Deep field-name guard used in addition to the strict ResumeMapV1 schema. */
export declare function assertResumeMapHasNoForbiddenFields(value: unknown): void;
export declare function computeResumeMapFingerprint(map: ResumeMapBody): string;
export declare function resumeMapUtf8Bytes(map: ResumeMapV1): number;
export declare function verifyResumeMapFingerprint(value: unknown): value is ResumeMapV1;
/**
 * Pure Session/Run projection. Stable IDs are runId, the string value for
 * blockers/decisions, publicationId, and (targetId, action) for actions.
 * Duplicate Run IDs select the highest revision (canonical JSON breaks
 * equal-revision ties); other arrays deduplicate by their stable ID, and action
 * duplicates select the highest authority-valid revision.
 */
export declare function projectResumeMapV1(input: ResumeMapProjectionInput): ResumeMapV1;
export {};
//# sourceMappingURL=resume-view.d.ts.map