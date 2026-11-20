import type { ArtifactRef, CollectionManifest, CuratorScope, DeliveryIntent, DeliveryReceipt, ProviderMaterial, Submission, GeneratedSummaryMetadata } from "./contracts.ts";
export interface SourceArtifactsPort {
  seal(value: unknown): ArtifactRef;
  read<T>(ref: ArtifactRef): T;
  head(collectionId: string): { revision: number; ref: ArtifactRef } | undefined;
  commit(collectionId: string, expectedRevision: number, value: CollectionManifest): void;
  list(): string[];
}
export interface CuratorAuthority { scope: CuratorScope; assert(): void; }
export interface SearchPort { search(query: string, provider: string | undefined, signal: AbortSignal): Promise<ProviderMaterial>; }
export interface SummaryPort {
  generate(queries: Submission["queries"], signal: AbortSignal, model?: string, feedback?: string): Promise<{ summary: string; meta: GeneratedSummaryMetadata }>;
  rewrite?(query: string, signal: AbortSignal): Promise<string>;
}
export interface HostDeliveryPort { enqueue(intent: DeliveryIntent, snapshot: Submission): Promise<DeliveryReceipt>; revoke(reason: string): void; }
export interface ClockPort { now(): number; }
export interface ActivityPort {
  start(query: string): string;
  finish(id: string, outcome: "completed" | "error" | "cancelled", error?: string): void;
}
