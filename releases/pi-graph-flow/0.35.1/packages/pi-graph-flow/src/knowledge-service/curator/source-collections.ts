import { randomUUID } from "node:crypto";
import { sourceHash } from "../../persistence-recovery/immutable-source-artifacts.ts";
import type { ArtifactRef, CollectionManifest, DeliveryIntent, GeneratedSummaryMetadata, ProviderMaterial, QueryProjection, Selection, Submission, SummaryMetadata } from "./contracts.ts";
import type { ClockPort, CuratorAuthority, SourceArtifactsPort } from "./ports.ts";

export class SourceCollections {
  private manifest: CollectionManifest;
  constructor(readonly artifacts: SourceArtifactsPort, readonly authority: CuratorAuthority, private readonly clock: ClockPort) {
    authority.assert(); const now = clock.now();
    this.manifest = { schema: "curator-collection/1", id: randomUUID(), scope: structuredClone(authority.scope), revision: 0, createdAt: now, updatedAt: now, state: "open", queries: [], selections: [], summaries: [], deliveries: [] };
    this.change(() => {});
  }
  get id(): string { return this.manifest.id; }
  snapshot(): CollectionManifest { return structuredClone(this.manifest); }
  /** Detect a missing, damaged or replaced head; in-memory state is not recovery authority. */
  assertCurrent(): void {
    this.authority.assert(); const head = this.artifacts.head(this.manifest.id);
    if (this.manifest.revision === 0) { if (head) throw new Error("Curator collection already exists"); return; }
    if (!head || head.revision !== this.manifest.revision || head.ref.sha256 !== sourceHash(this.manifest)) throw new Error("Curator head is missing, stale or replaced");
  }
  private change(update: (next: CollectionManifest) => void): void {
    this.assertCurrent(); const next = structuredClone(this.manifest); update(next); next.revision++; next.updatedAt = this.clock.now();
    this.authority.assert(); this.artifacts.commit(next.id, this.manifest.revision, next); this.authority.assert(); this.manifest = next;
  }
  begin(query: string, index: number, provider?: string): void {
    if (!query.trim() || !Number.isSafeInteger(index) || index < 0 || this.manifest.state !== "open" || this.manifest.queries.some(q => q.index === index)) throw new Error("Invalid or duplicate Curator query");
    this.change(next => next.queries.push({ id: randomUUID(), index, query: query.trim(), requestedProvider: provider, startedAt: this.clock.now(), status: "pending", sources: [] }));
  }
  complete(index: number, material: ProviderMaterial): QueryProjection {
    this.authority.assert();
    if (!material || typeof material.provider !== "string" || !Array.isArray(material.results) || (material.answer !== null && typeof material.answer !== "string") || material.results.some(r => !r || typeof r.url !== "string" || typeof r.title !== "string" || typeof r.snippet !== "string")) throw new Error("Unsupported provider material");
    const copy = structuredClone(material), ref = this.artifacts.seal(copy);
    this.change(next => {
      const query = next.queries.find(q => q.index === index);
      if (!query || query.status !== "pending" || next.state !== "open") throw new Error("Curator query is no longer pending");
      query.status = "completed"; query.completedAt = this.clock.now(); query.material = ref; query.provider = copy.provider;
      query.sources = copy.results.map((r, rank) => ({ sourceId: sourceHash({ url: r.url }), versionId: sourceHash({ response: ref.sha256, rank }), rank, url: r.url,
        evidenceKind: typeof r.content === "string" && r.content.length > 0 ? "provider-extracted-text" : "search-discovered" }));
    });
    return this.project(index);
  }
  fail(index: number, error: string, cancelled: boolean): void {
    this.change(next => { const q = next.queries.find(q => q.index === index); if (q?.status === "pending") { q.status = cancelled ? "cancelled" : "error"; q.completedAt = this.clock.now(); q.error = error; } });
  }
  project(index: number): QueryProjection {
    this.assertCurrent(); const q = this.manifest.queries.find(q => q.index === index);
    if (!q || q.status !== "completed" || !q.material) throw new Error("Selected Curator query has not completed");
    const material = this.artifacts.read<ProviderMaterial>(q.material); this.authority.assert();
    return { query: q.query, answer: material.answer ?? "", provider: material.provider, version: q.material.sha256,
      results: material.results.map((r, i) => ({ ...r, domain: domain(r.url), sourceVersion: q.sources[i].versionId, evidenceKind: q.sources[i].evidenceKind })) };
  }
  selection(indices: number[], supplied?: Selection[]): { selections: Selection[]; queries: Submission["queries"] } {
    this.authority.assert(); if (!indices.length || new Set(indices).size !== indices.length) throw new Error("Choose completed Curator results");
    const selections: Selection[] = [], queries: Submission["queries"] = [];
    for (const index of indices) {
      const p = this.project(index), input = supplied?.find(s => s.queryIndex === index);
      if (supplied && !input) throw new Error("Missing exact selection version");
      if (input && (input.version !== p.version || !Array.isArray(input.sourceVersions) || new Set(input.sourceVersions).size !== input.sourceVersions.length || input.sourceVersions.some(v => !p.results.some(r => r.sourceVersion === v)))) throw new Error("Source selection version mismatch");
      const chosen = input?.sourceVersions ?? p.results.map(r => r.sourceVersion);
      selections.push({ queryIndex: index, version: p.version, sourceVersions: [...chosen] });
      const filtered = p.results.filter(r => chosen.includes(r.sourceVersion)).map(({ domain: _domain, sourceVersion: _version, evidenceKind: _kind, ...r }) => r);
      // A provider answer may cite unselected sources; do not retain it under a partial source selection.
      queries.push({ query: p.query, answer: chosen.length === p.results.length ? p.answer : "", results: filtered, provider: p.provider });
    }
    if (supplied && supplied.length !== indices.length) throw new Error("Unexpected source selection");
    if (queries.every(query => !query.answer.trim() && query.results.length === 0)) throw new Error("Selected sources contain no material");
    this.change(next => { next.selections = selections; });
    return { selections, queries };
  }
  saveSummary(selections: Selection[], summary: string, meta: GeneratedSummaryMetadata): void {
    if (!summary.trim()) throw new Error("Empty Curator summary");
    const ref = this.artifacts.seal({ summary, meta, selections });
    this.change(next => { next.summaries.push({ selectionHash: sourceHash(selections), ref }); });
  }
  sealSubmission(indices: number[], supplied: Selection[] | undefined, options: { summary?: string; summaryMeta?: SummaryMetadata; rawResults?: boolean }): { ref: ArtifactRef; value: Submission } {
    const selected = this.selection(indices, supplied);
    let summaryMeta: SummaryMetadata | undefined;
    if (options.summary) {
      // Browser metadata is a client assertion, never a generation receipt. Only
      // exact text and exact source versions can reuse a trusted Host generation.
      const selectionHash = sourceHash(selected.selections);
      for (const record of [...this.manifest.summaries].reverse()) {
        if (record.selectionHash !== selectionHash) continue;
        const generated = this.artifacts.read<{ summary: string; meta: GeneratedSummaryMetadata; selections: Selection[] }>(record.ref);
        this.authority.assert();
        if (sourceHash(generated.selections) !== selectionHash) throw new Error("Summary selection provenance mismatch");
        if (generated.summary === options.summary) {
          summaryMeta = { ...generated.meta, origin: "host-generated", sourceSummary: record.ref, edited: false }; break;
        }
      }
      // Without an exact generated version, we cannot infer which draft an edit
      // came from, even when the selected sources happen to be the same.
      summaryMeta ??= { model: null, durationMs: 0, tokenEstimate: Math.ceil(options.summary.length / 4), fallbackUsed: false, phase: "user-provided", origin: "user-provided", edited: true };
    }
    const value: Submission = { schema: "curator-submission/1", collectionId: this.id, scope: structuredClone(this.authority.scope), ...selected,
      rawResults: options.rawResults === true, ...(options.summary ? { summary: options.summary, summaryMeta } : {}) };
    const ref = this.artifacts.seal(value); this.authority.assert(); return { ref, value };
  }
  delivery(intent: DeliveryIntent): void { this.change(next => { const i = next.deliveries.findIndex(d => d.id === intent.id); if (i < 0) next.deliveries.push(structuredClone(intent)); else next.deliveries[i] = structuredClone(intent); }); }
  close(state: "submitted" | "cancelled" | "closed"): void {
    this.change(next => { next.state = state; for (const q of next.queries) if (q.status === "pending") { q.status = "cancelled"; q.completedAt = this.clock.now(); q.error = state; } });
  }
  history(): Array<{ id: string; revision: number; state: string; readOnly: true }> {
    this.authority.assert(); return this.artifacts.list().map(id => { const head = this.artifacts.head(id); if (!head) throw new Error("Missing historical Curator head"); const value = this.artifacts.read<CollectionManifest>(head.ref);
      if (value.scope.workspaceHash !== this.authority.scope.workspaceHash || value.scope.sessionHash !== this.authority.scope.sessionHash) throw new Error("Historical source scope mismatch");
      return { id, revision: value.revision, state: value.state, readOnly: true as const }; });
  }
  historical(id: string): CollectionManifest {
    this.authority.assert(); const head = this.artifacts.head(id); if (!head) throw new Error("Historical collection is missing");
    const value = this.artifacts.read<CollectionManifest>(head.ref); if (value.scope.workspaceHash !== this.authority.scope.workspaceHash || value.scope.sessionHash !== this.authority.scope.sessionHash) throw new Error("Historical source scope mismatch");
    for (const q of value.queries) if (q.material) this.artifacts.read(q.material);
    for (const summary of value.summaries) this.artifacts.read(summary.ref);
    this.authority.assert(); return value;
  }
}
function domain(url: string): string { try { return new URL(url).hostname; } catch { return ""; } }
