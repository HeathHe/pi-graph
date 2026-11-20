export interface ArtifactRef { sha256: string; byteLength: number; }
export interface CuratorScope {
  workspaceHash: string; sessionHash: string; rootOwnerId: string;
  branchGeneration: number; curatorGeneration: string;
}
export interface ProviderSource {
  title: string; url: string; snippet: string; content?: string;
}
export interface ProviderMaterial {
  answer: string | null; provider: string; results: ProviderSource[];
}
export interface SourceVersion {
  sourceId: string; versionId: string; rank: number; url: string;
  evidenceKind: "search-discovered" | "provider-extracted-text";
}
export interface QueryRecord {
  id: string; index: number; query: string; requestedProvider?: string;
  startedAt: number; completedAt?: number;
  status: "pending" | "completed" | "error" | "cancelled";
  material?: ArtifactRef; provider?: string; sources: SourceVersion[]; error?: string;
}
export interface Selection { queryIndex: number; version: string; sourceVersions: string[]; }
export interface SummaryMetadata {
  model: string | null; durationMs: number; tokenEstimate: number; fallbackUsed: boolean;
  fallbackReason?: string; phase?: "summary-model" | "deterministic-fallback" | "user-provided"; edited?: boolean;
  origin?: "host-generated" | "user-provided"; sourceSummary?: ArtifactRef;
}
/** Generation ports cannot claim that a client-supplied draft was model output. */
export type GeneratedSummaryMetadata = Omit<SummaryMetadata, "phase" | "origin" | "sourceSummary"> & {
  phase?: "summary-model" | "deterministic-fallback";
};
export interface Submission {
  schema: "curator-submission/1"; collectionId: string; scope: CuratorScope;
  selections: Selection[]; queries: Array<{ query: string; answer: string; results: ProviderSource[]; provider: string }>;
  summary?: string; summaryMeta?: SummaryMetadata; rawResults: boolean;
}
export type DeliveryState = "enqueue_attempted" | "unknown" | "canonical_ticket_seen" | "materialized_host_context" | "rejected" | "cancelled";
export interface DeliveryIntent {
  id: string; scope: CuratorScope; snapshot: ArtifactRef; state: DeliveryState;
  anchorId: string; canonicalEntryId?: string; materializedHash?: string; reason?: string;
}
export interface CollectionManifest {
  schema: "curator-collection/1"; id: string; scope: CuratorScope; revision: number;
  createdAt: number; updatedAt: number; state: "open" | "submitted" | "cancelled" | "closed";
  queries: QueryRecord[]; selections: Selection[];
  summaries: Array<{ selectionHash: string; ref: ArtifactRef }>;
  deliveries: DeliveryIntent[];
}
export interface QueryProjection {
  query: string; answer: string; results: Array<ProviderSource & { domain: string; sourceVersion: string; evidenceKind: SourceVersion["evidenceKind"] }>;
  provider: string; version: string;
}
export interface DeliveryReceipt { deliveryId: string; state: DeliveryState; canonicalEntryId?: string; materializedHash?: string; reason?: string; }
