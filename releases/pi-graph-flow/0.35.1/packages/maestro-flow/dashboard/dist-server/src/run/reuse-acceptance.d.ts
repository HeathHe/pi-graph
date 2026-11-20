import type { ExecutionSealReceiptAnchor, ReuseAssessmentInput, ReuseAssessmentRead, ReuseSourceFenceRead } from './reuse-assessment.js';
import { SessionStore } from './store.js';
export declare function buildReuseExecutionAnchor(projectRoot: string, sessionId: string, producerRunId: string, artifactId: string, authorityStore?: SessionStore): ExecutionSealReceiptAnchor | null;
export declare function assessReceiptBackedArtifactReuse(projectRoot: string, input: ReuseAssessmentInput, authorityStore?: SessionStore): ReuseAssessmentRead;
export declare function validateReuseSourceFence(projectRoot: string, fence: ReuseSourceFenceRead, authorityStore?: SessionStore): void;
export declare function validateReuseAcceptance(projectRoot: string, assessment: ReuseAssessmentRead, authorityStore?: SessionStore): void;
