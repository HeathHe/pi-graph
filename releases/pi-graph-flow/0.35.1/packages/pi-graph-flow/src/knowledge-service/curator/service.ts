import { randomUUID } from "node:crypto";
import { sourceHash } from "../../persistence-recovery/immutable-source-artifacts.ts";
import type { DeliveryIntent, DeliveryReceipt, QueryProjection, Selection, SummaryMetadata } from "./contracts.ts";
import type { ActivityPort, HostDeliveryPort, SearchPort, SummaryPort } from "./ports.ts";
import { SourceCollections } from "./source-collections.ts";

export class CuratorService {
  private abort = new AbortController();
  private summaryAbort: AbortController | undefined;
  private summarySequence = 0;
  private terminal = false;
  private submissionAttempted = false;
  private submission: Promise<DeliveryReceipt> | undefined;
  constructor(readonly sources: SourceCollections, private readonly searchPort: SearchPort, private readonly summaryPort: SummaryPort, private readonly deliveryPort: HostDeliveryPort, private readonly activity: ActivityPort) {}
  get submissionStarted(): boolean { return this.submissionAttempted; }
  private assert(): void { this.sources.authority.assert(); if (this.terminal || this.abort.signal.aborted) throw new Error("Curator session closed"); }
  async search(query: string, index: number, provider?: string): Promise<QueryProjection> {
    this.assert(); this.sources.begin(query, index, provider); const activity = this.activity.start(query);
    try { const result = await this.searchPort.search(query, provider, this.abort.signal); this.assert(); const projection = this.sources.complete(index, result); this.activity.finish(activity, "completed"); return projection; }
    catch (error) { const cancelled = this.abort.signal.aborted; this.activity.finish(activity, cancelled ? "cancelled" : "error", String(error));
      try { if (!this.terminal) this.sources.fail(index, error instanceof Error ? error.message : String(error), cancelled); } catch { /* invalid source cannot publish */ } throw error; }
  }
  async summarize(indices: number[], signal: AbortSignal, model?: string, feedback?: string, selections?: Selection[]) {
    this.assert(); this.summaryAbort?.abort(); const controller = new AbortController(); this.summaryAbort = controller; const seq = ++this.summarySequence;
    const selected = this.sources.selection(indices, selections), selectionHash = sourceHash(selected.selections);
    const combined = AbortSignal.any([signal, controller.signal, this.abort.signal]);
    const result = await this.summaryPort.generate(selected.queries, combined, model, feedback);
    this.assert(); if (combined.aborted || seq !== this.summarySequence || sourceHash(this.sources.snapshot().selections) !== selectionHash) throw new Error("Curator summary superseded");
    this.sources.saveSummary(selected.selections, result.summary, result.meta); return result;
  }
  async rewrite(query: string, signal: AbortSignal): Promise<string> {
    this.assert(); if (!this.summaryPort.rewrite) throw new Error("Query rewrite is unavailable; edit the query directly");
    const text = await this.summaryPort.rewrite(query, AbortSignal.any([signal, this.abort.signal])); this.assert(); return text;
  }
  submit(indices: number[], options: { summary?: string; summaryMeta?: SummaryMetadata; rawResults?: boolean; selections?: Selection[] }, anchorId: string): Promise<DeliveryReceipt> {
    if (this.submission) return this.submission;
    this.assert(); const sealed = this.sources.sealSubmission(indices, options.selections, options);
    const intent: DeliveryIntent = { id: randomUUID(), scope: structuredClone(this.sources.authority.scope), snapshot: sealed.ref, state: "enqueue_attempted", anchorId };
    this.sources.delivery(intent);
    this.submissionAttempted = true;
    this.submission = (async () => {
      // Once enqueue has been attempted its outcome is reconciled by the Host; never auto-repeat.
      const latest = (receipt: DeliveryReceipt): DeliveryIntent => {
        const observed = this.sources.snapshot().deliveries.find(d => d.id === intent.id) ?? intent;
        const rank = { enqueue_attempted: 0, unknown: 1, canonical_ticket_seen: 2, materialized_host_context: 3, rejected: 4, cancelled: 4 };
        return rank[observed.state] >= rank[receipt.state] ? observed : { ...observed, ...receipt, id: intent.id };
      };
      const result = (value: DeliveryIntent): DeliveryReceipt => ({ deliveryId: value.id, state: value.state, canonicalEntryId: value.canonicalEntryId, materializedHash: value.materializedHash, reason: value.reason });
      try {
        const received = await this.deliveryPort.enqueue(intent, sealed.value), effective = latest(received);
        this.sources.delivery(effective); this.sources.close("submitted"); this.terminal = true; this.abort.abort(); return result(effective);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error), effective = latest({ deliveryId: intent.id, state: "unknown", reason });
        try { this.sources.delivery(effective); this.sources.close("submitted"); } catch { /* reconcile the original attempt; never resend */ }
        this.terminal = true; this.abort.abort(); return result(effective);
      }
    })(); return this.submission;
  }
  close(reason: "cancelled" | "closed" = "closed"): void {
    if (this.terminal && reason !== "cancelled") return;
    this.deliveryPort.revoke(reason); this.abort.abort(); this.summaryAbort?.abort();
    if (!this.terminal) { try { this.sources.close(reason); } finally { this.terminal = true; } }
  }
}
