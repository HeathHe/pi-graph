import { type ArtifactCompatibilityAssessment, type ArtifactRepublishReceipt } from './protocol-schemas.js';
import { type Artifact } from './schemas.js';
import { SessionStore } from './store.js';
export type CompatibilityRole = Artifact['role'];
export interface ArtifactCompatibilitySlot {
    kind: string;
    schema: string;
    role: CompatibilityRole;
    alias: string;
}
export interface AssessArtifactCompatibilityInput {
    source: ArtifactCompatibilityAssessment['source'];
    consumer: ArtifactCompatibilityAssessment['consumer'];
    source_status: Artifact['status'];
    producer_status: string;
    source_hash_valid: boolean;
    source_is_top_level_json: boolean;
    source_metadata_valid: boolean;
    producer_contract_captured: boolean;
}
export interface InspectArtifactCompatibilityOptions {
    sessionId: string;
    artifactId: string;
    consumerCommand: string;
    alias: string;
}
export interface PrepareArtifactRepublishOptions extends InspectArtifactCompatibilityOptions {
    assessmentHash: string;
    requestId: string;
    expectedArtifactRevision: number;
    expectedSessionRevision: number;
    participantId: string;
    actorId: string;
    reason: string;
    evidenceRefs: readonly string[];
    recordedAt?: string;
}
export interface PreparedArtifactRepublish {
    assessment: ArtifactCompatibilityAssessment;
    sourceArtifact: Artifact;
    artifact: Artifact;
    artifactId: string;
    artifactPath: string;
    content: string;
    compatibilityRunId: string;
    compatibilityStepId: string;
    recordedAt: string;
}
export declare function assessArtifactCompatibility(input: AssessArtifactCompatibilityInput): ArtifactCompatibilityAssessment;
export declare function inspectArtifactCompatibility(projectRoot: string, options: InspectArtifactCompatibilityOptions, authorityStore?: SessionStore): ArtifactCompatibilityAssessment;
export declare function prepareArtifactRepublish(projectRoot: string, options: PrepareArtifactRepublishOptions, authorityStore?: SessionStore): PreparedArtifactRepublish;
export declare function artifactRepublishReceiptHash(receipt: ArtifactRepublishReceipt): string;
export declare function createArtifactRepublishReceipt(input: Omit<ArtifactRepublishReceipt, 'schema_version' | 'receipt_hash'>): ArtifactRepublishReceipt;
export declare function artifactRepublishReceiptPath(store: SessionStore, sessionId: string, receiptId: string): string;
export declare function findArtifactRepublishReceipts(store: SessionStore, sessionId: string): ArtifactRepublishReceipt[];
export declare function exactArtifactRepublishReceipt(store: SessionStore, sessionId: string, artifactId: string, consumer: ArtifactCompatibilityAssessment['consumer']): ArtifactRepublishReceipt | null;
