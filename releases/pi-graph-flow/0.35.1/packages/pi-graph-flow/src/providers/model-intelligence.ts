import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TeammateTaskType } from "pi-maestro-teammate/v1/model-routing";
import { normalizeModelId } from "./model-discovery.ts";

export const MODEL_INTELLIGENCE_DIMENSIONS = [
  "intelligence",
  "coding",
  "agentic",
  "price",
  "latency",
] as const;

export type ModelIntelligenceDimension = typeof MODEL_INTELLIGENCE_DIMENSIONS[number];

export const MODEL_INTELLIGENCE_PREFERENCES = ["economy", "balanced", "sota"] as const;
export type ModelIntelligencePreference = typeof MODEL_INTELLIGENCE_PREFERENCES[number];

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
}

interface OpenRouterModelEntry {
  id: string;
  canonical_slug?: string;
  context_length?: number;
  pricing?: OpenRouterPricing;
}

interface ModelIntelligenceCacheFile {
  version: 1;
  fetchedAt: number;
  lists: Partial<Record<ModelIntelligenceDimension, OpenRouterModelEntry[]>>;
}

interface ModelMatch {
  entry: OpenRouterModelEntry;
  rank: ModelIntelligenceRank;
  via: "exact" | "unambiguous-alias";
}

export interface AvailableModelIdentity {
  registrationId: string;
  modelId?: string;
}

export interface ModelIntelligenceRank {
  rank: number;
  total: number;
}

export interface ModelIntelligenceCandidate {
  registration_id: string;
  benchmark_model_id: string;
  equivalent_registration_ids?: string[];
  matched_via?: "exact" | "unambiguous-alias";
  strengths: string[];
  ranks: Partial<Record<ModelIntelligenceDimension, ModelIntelligenceRank>>;
  missing_dimensions?: ModelIntelligenceDimension[];
  selection_score?: number;
  reference_pricing_usd_per_million?: {
    input: number;
    output: number;
  };
  context_length?: number;
  confidence: "low" | "medium" | "high";
}

export type ModelIntelligenceRecommendationReason =
  | "materially-better"
  | "only-eligible-candidate"
  | "no-candidates"
  | "stale-snapshot"
  | "insufficient-evidence"
  | "missing-primary-dimension"
  | "material-tie"
  | "equivalent-route-tie";

export interface ModelIntelligenceView {
  status: "available" | "stale" | "unavailable";
  task_type: TeammateTaskType;
  preference: ModelIntelligencePreference;
  recommendation: string | null;
  selection?: {
    method: "weighted-normalized-rank";
    dimension_weights: Array<{ dimension: ModelIntelligenceDimension; weight: number }>;
    materiality_threshold: number;
    recommendation_reason: ModelIntelligenceRecommendationReason;
    loaded_dimensions: ModelIntelligenceDimension[];
    missing_dimensions: ModelIntelligenceDimension[];
    coverage: {
      available_models: number;
      matched_models: number;
      unmatched_models: number;
      distinct_benchmarks: number;
      returned_candidates: number;
    };
  };
  candidates: ModelIntelligenceCandidate[];
  unmatched_models: string[];
  sources: Array<{
    id: "openrouter-models-api";
    url: string;
    fetched_at: string;
    expires_at: string;
    reference_only: true;
  }>;
  note: string;
}

type ScoredCandidate = ModelIntelligenceCandidate & Required<Pick<
  ModelIntelligenceCandidate,
  "equivalent_registration_ids" | "matched_via" | "missing_dimensions" | "selection_score"
>>;

export interface LoadModelIntelligenceOptions {
  cachePath?: string;
  ttlMs?: number;
  baseUrl?: string;
  timeoutMs?: number;
  limit?: number;
  preference?: ModelIntelligencePreference;
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MATERIALITY_THRESHOLD = 0.02;
const SAFE_MODEL_ID = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;

const SORT_BY_DIMENSION = {
  intelligence: "intelligence-high-to-low",
  coding: "coding-high-to-low",
  agentic: "agentic-high-to-low",
  price: "pricing-low-to-high",
  latency: "latency-low-to-high",
} as const satisfies Record<ModelIntelligenceDimension, string>;

interface TaskDimensionPolicy {
  balanced: readonly ModelIntelligenceDimension[];
  sota: readonly ModelIntelligenceDimension[];
}

const DEFAULT_TASK_POLICY: TaskDimensionPolicy = {
  balanced: ["intelligence", "price", "latency"],
  sota: ["intelligence", "coding", "agentic"],
};

const TASK_DIMENSION_POLICIES: Record<string, TaskDimensionPolicy> = {
  explore: { balanced: ["latency", "price", "intelligence"], sota: ["intelligence", "coding", "agentic"] },
  analysis: { balanced: ["intelligence", "price", "latency"], sota: ["intelligence", "agentic", "coding"] },
  debug: { balanced: ["coding", "intelligence", "agentic"], sota: ["coding", "intelligence", "agentic"] },
  planning: { balanced: ["intelligence", "price", "latency"], sota: ["intelligence", "agentic", "coding"] },
  development: { balanced: ["coding", "agentic", "intelligence"], sota: ["coding", "agentic", "intelligence"] },
  review: { balanced: ["intelligence", "coding", "agentic"], sota: ["intelligence", "coding", "agentic"] },
  testing: { balanced: ["coding", "agentic", "price"], sota: ["coding", "agentic", "intelligence"] },
};

interface SharedRefresh {
  promise: Promise<ModelIntelligenceCacheFile>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

const inFlightRefreshes = new Map<string, SharedRefresh>();

function selectionDimensions(
  taskType: TeammateTaskType,
  preference: ModelIntelligencePreference,
): readonly ModelIntelligenceDimension[] {
  const policy = TASK_DIMENSION_POLICIES[taskType] ?? DEFAULT_TASK_POLICY;
  if (preference === "sota") return policy.sota;
  if (preference === "economy") {
    return ["price", ...policy.balanced.filter((dimension) => dimension !== "price")];
  }
  return policy.balanced;
}

function dimensionWeights(
  dimensions: readonly ModelIntelligenceDimension[],
): Array<{ dimension: ModelIntelligenceDimension; weight: number }> {
  if (dimensions.length === 1) return [{ dimension: dimensions[0]!, weight: 1 }];
  const secondaryWeight = 0.5 / (dimensions.length - 1);
  return dimensions.map((dimension, index) => ({
    dimension,
    weight: index === 0 ? 0.5 : secondaryWeight,
  }));
}

function cachePath(): string {
  return join(getAgentDir(), "model-intelligence-openrouter.json");
}

function normalizeEntry(value: unknown): OpenRouterModelEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!SAFE_MODEL_ID.test(id)) return undefined;
  const canonicalSlug = typeof record.canonical_slug === "string" && SAFE_MODEL_ID.test(record.canonical_slug.trim())
    ? record.canonical_slug.trim()
    : undefined;
  const contextLength = typeof record.context_length === "number"
    && Number.isFinite(record.context_length)
    && record.context_length > 0
    ? record.context_length
    : undefined;
  const pricingRecord = record.pricing && typeof record.pricing === "object" && !Array.isArray(record.pricing)
    ? record.pricing as Record<string, unknown>
    : undefined;
  const prompt = typeof pricingRecord?.prompt === "string" && pricingRecord.prompt.length <= 64
    ? pricingRecord.prompt
    : undefined;
  const completion = typeof pricingRecord?.completion === "string" && pricingRecord.completion.length <= 64
    ? pricingRecord.completion
    : undefined;
  return {
    id,
    ...(canonicalSlug ? { canonical_slug: canonicalSlug } : {}),
    ...(contextLength ? { context_length: contextLength } : {}),
    ...(prompt || completion ? { pricing: { ...(prompt ? { prompt } : {}), ...(completion ? { completion } : {}) } } : {}),
  };
}

function normalizeLists(value: unknown): ModelIntelligenceCacheFile["lists"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const lists: ModelIntelligenceCacheFile["lists"] = {};
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    const list = (value as Record<string, unknown>)[dimension];
    if (!Array.isArray(list)) continue;
    const entries = list.map(normalizeEntry).filter((entry): entry is OpenRouterModelEntry => entry !== undefined);
    if (entries.length > 0) lists[dimension] = entries;
  }
  return Object.keys(lists).length > 0 ? lists : undefined;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= Date.now() + MAX_CLOCK_SKEW_MS
    && value <= 8_640_000_000_000_000;
}

function completeSnapshot(lists: ModelIntelligenceCacheFile["lists"]): boolean {
  return MODEL_INTELLIGENCE_DIMENSIONS.every((dimension) => (lists[dimension]?.length ?? 0) > 0);
}

async function readCache(path: string): Promise<ModelIntelligenceCacheFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<ModelIntelligenceCacheFile>;
    const lists = normalizeLists(parsed.lists);
    if (parsed.version !== 1 || !validTimestamp(parsed.fetchedAt) || !lists) return undefined;
    return { version: 1, fetchedAt: parsed.fetchedAt, lists };
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: ModelIntelligenceCacheFile): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify(cache)}\n`, "utf8");
    await rename(temp, path);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function fetchLists(
  baseUrl: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  callerSignal?: AbortSignal,
): Promise<ModelIntelligenceCacheFile["lists"]> {
  callerSignal?.throwIfAborted();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestController = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal, requestController.signal])
    : AbortSignal.any([timeoutSignal, requestController.signal]);
  let firstError: unknown;
  const requests = MODEL_INTELLIGENCE_DIMENSIONS.map(async (dimension) => {
    try {
      const url = new URL(baseUrl);
      url.searchParams.set("sort", SORT_BY_DIMENSION[dimension]);
      const response = await fetchFn(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (response.redirected) throw new Error("OpenRouter models API redirect rejected");
      if (!response.ok) throw new Error(`OpenRouter models API HTTP ${response.status}`);
      const payload = await response.json() as { data?: unknown };
      const ranking = Array.isArray(payload.data)
        ? payload.data.map(normalizeEntry).filter((entry): entry is OpenRouterModelEntry => entry !== undefined)
        : [];
      if (ranking.length === 0) throw new Error(`OpenRouter returned no valid ${dimension} ranking`);
      return [dimension, ranking] as const;
    } catch (error) {
      if (firstError === undefined) firstError = error;
      requestController.abort();
      throw error;
    }
  });
  const settled = await Promise.allSettled(requests);
  callerSignal?.throwIfAborted();
  if (firstError !== undefined) throw firstError;
  const entries = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  return Object.fromEntries(entries) as ModelIntelligenceCacheFile["lists"];
}

async function waitForRefresh(
  refresh: SharedRefresh,
  signal: AbortSignal | undefined,
): Promise<ModelIntelligenceCacheFile> {
  signal?.throwIfAborted();
  refresh.waiters++;
  let onAbort: (() => void) | undefined;
  try {
    if (!signal) return await refresh.promise;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Model intelligence request aborted"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([refresh.promise, aborted]);
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    refresh.waiters--;
    if (refresh.waiters === 0 && !refresh.settled) refresh.controller.abort();
  }
}

async function loadCache(options: LoadModelIntelligenceOptions): Promise<{
  cache?: ModelIntelligenceCacheFile;
  stale: boolean;
}> {
  options.signal?.throwIfAborted();
  const path = options.cachePath ?? cachePath();
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const baseUrl = options.baseUrl ?? OPENROUTER_MODELS_URL;
  const existing = await readCache(path);
  const age = existing ? Math.max(0, Date.now() - existing.fetchedAt) : Number.POSITIVE_INFINITY;
  if (existing && completeSnapshot(existing.lists) && age < ttlMs) return { cache: existing, stale: false };

  const refreshKey = `${path}\0${baseUrl}`;
  let refresh = inFlightRefreshes.get(refreshKey);
  if (!refresh) {
    const controller = new AbortController();
    let state!: SharedRefresh;
    const promise = (async () => {
      const lists = await fetchLists(
        baseUrl,
        options.timeoutMs ?? FETCH_TIMEOUT_MS,
        options.fetchFn ?? fetch,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      const next: ModelIntelligenceCacheFile = { version: 1, fetchedAt: Date.now(), lists };
      await writeCache(path, next);
      return next;
    })().finally(() => {
      state.settled = true;
      if (inFlightRefreshes.get(refreshKey) === state) inFlightRefreshes.delete(refreshKey);
    });
    state = { controller, waiters: 0, settled: false, promise };
    refresh = state;
    inFlightRefreshes.set(refreshKey, state);
  }

  try {
    const cache = await waitForRefresh(refresh, options.signal);
    return { cache, stale: false };
  } catch {
    if (options.signal?.aborted) throw new Error("Model intelligence request aborted");
    return existing ? { cache: existing, stale: true } : { stale: false };
  }
}

function qualifiedId(value: string): string {
  return value.trim().toLowerCase().replace(/[:_]/g, "-");
}

function qualifiedAliases(model: AvailableModelIdentity): string[] {
  return [...new Set([model.registrationId, model.modelId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(qualifiedId))];
}

function leafAliases(model: AvailableModelIdentity): string[] {
  return [...new Set([model.registrationId, model.modelId]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map(normalizeModelId))];
}

function entryIds(entry: OpenRouterModelEntry): string[] {
  return [entry.id, entry.canonical_slug].filter((value): value is string => typeof value === "string");
}

function providerNamespace(value: string): string | undefined {
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash).toLowerCase() : undefined;
}

function aliasProviderCompatible(model: AvailableModelIdentity, entry: OpenRouterModelEntry): boolean {
  const modelIds = model.modelId ? [model.modelId] : [model.registrationId];
  const modelProviders = new Set(modelIds.map(providerNamespace).filter((value): value is string => value !== undefined));
  const entryProviders = new Set(entryIds(entry).map(providerNamespace).filter((value): value is string => value !== undefined));
  if (entryProviders.size === 0) return true;
  return [...entryProviders].some((provider) => modelProviders.has(provider));
}

function rankFor(
  list: readonly OpenRouterModelEntry[] | undefined,
  model: AvailableModelIdentity,
  models: readonly AvailableModelIdentity[],
): ModelMatch | undefined {
  if (!list) return undefined;
  const exact = new Set(qualifiedAliases(model));
  const exactIndex = list.findIndex((entry) => entryIds(entry).some((id) => exact.has(qualifiedId(id))));
  if (exactIndex >= 0) {
    return { entry: list[exactIndex]!, rank: { rank: exactIndex + 1, total: list.length }, via: "exact" };
  }

  for (const leaf of leafAliases(model)) {
    const modelOwners = models.filter((candidate) => leafAliases(candidate).includes(leaf));
    const entryIndexes = list.flatMap((entry, index) =>
      aliasProviderCompatible(model, entry)
        && entryIds(entry).some((id) => normalizeModelId(id) === leaf)
        ? [index]
        : []);
    if (modelOwners.length !== 1 || entryIndexes.length !== 1) continue;
    const index = entryIndexes[0]!;
    return { entry: list[index]!, rank: { rank: index + 1, total: list.length }, via: "unambiguous-alias" };
  }
  return undefined;
}

function perMillion(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * 1_000_000 : undefined;
}

function candidateFor(
  model: AvailableModelIdentity,
  models: readonly AvailableModelIdentity[],
  lists: ModelIntelligenceCacheFile["lists"],
  weights: readonly { dimension: ModelIntelligenceDimension; weight: number }[],
): ScoredCandidate | undefined {
  const matches = new Map<ModelIntelligenceDimension, ModelMatch | undefined>();
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    matches.set(dimension, rankFor(lists[dimension], model, models));
  }
  const representative = MODEL_INTELLIGENCE_DIMENSIONS.map((dimension) => matches.get(dimension)).find(Boolean);
  if (!representative) return undefined;

  const ranks: ModelIntelligenceCandidate["ranks"] = {};
  const strengths: string[] = [];
  for (const dimension of MODEL_INTELLIGENCE_DIMENSIONS) {
    const match = matches.get(dimension);
    if (!match) continue;
    ranks[dimension] = match.rank;
    if (match.rank.rank <= Math.max(1, Math.ceil(match.rank.total / 4))) strengths.push(dimension);
  }
  const missingDimensions = weights
    .map(({ dimension }) => dimension)
    .filter((dimension) => ranks[dimension] === undefined);
  const input = perMillion(representative.entry.pricing?.prompt);
  const output = perMillion(representative.entry.pricing?.completion);
  const matchedVia = [...matches.values()].some((match) => match?.via === "unambiguous-alias")
    ? "unambiguous-alias"
    : "exact";
  const evidenceCount = weights.length - missingDimensions.length;
  const hasPrimary = ranks[weights[0]!.dimension] !== undefined;
  const confidence = matchedVia === "unambiguous-alias" || !hasPrimary
    ? "low"
    : evidenceCount >= weights.length
      ? "high"
      : evidenceCount >= Math.max(1, weights.length - 1)
        ? "medium"
        : "low";
  const selectionScore = weights.reduce((score, { dimension, weight }) => {
    const rank = ranks[dimension];
    const normalized = rank ? rank.rank / Math.max(1, rank.total) : 1;
    return score + normalized * weight;
  }, 0);
  return {
    registration_id: model.registrationId,
    benchmark_model_id: representative.entry.canonical_slug ?? representative.entry.id,
    equivalent_registration_ids: [model.registrationId],
    matched_via: matchedVia,
    strengths,
    ranks,
    missing_dimensions: missingDimensions,
    selection_score: Number(selectionScore.toFixed(6)),
    ...(input === undefined || output === undefined ? {} : {
      reference_pricing_usd_per_million: { input, output },
    }),
    ...(representative.entry.context_length === undefined ? {} : { context_length: representative.entry.context_length }),
    confidence,
  };
}

function compareCandidates(left: ScoredCandidate, right: ScoredCandidate): number {
  const leftLow = left.confidence === "low" ? 1 : 0;
  const rightLow = right.confidence === "low" ? 1 : 0;
  if (leftLow !== rightLow) return leftLow - rightLow;
  if (left.selection_score !== right.selection_score) return left.selection_score - right.selection_score;
  return left.registration_id.localeCompare(right.registration_id);
}

function distinctBenchmarkCandidates(candidates: readonly ScoredCandidate[]): ScoredCandidate[] {
  const grouped = new Map<string, ScoredCandidate[]>();
  for (const candidate of candidates) {
    const group = grouped.get(candidate.benchmark_model_id) ?? [];
    group.push(candidate);
    grouped.set(candidate.benchmark_model_id, group);
  }
  return [...grouped.values()].map((group) => ({
    ...group[0]!,
    equivalent_registration_ids: group.map((candidate) => candidate.registration_id).sort((left, right) => left.localeCompare(right)),
  })).sort(compareCandidates);
}

function recommendationFor(
  candidates: readonly ScoredCandidate[],
  stale: boolean,
  primaryDimension: ModelIntelligenceDimension,
): { recommendation: string | null; reason: ModelIntelligenceRecommendationReason } {
  const first = candidates[0];
  if (!first) return { recommendation: null, reason: "no-candidates" };
  if (stale) return { recommendation: null, reason: "stale-snapshot" };
  if (first.ranks[primaryDimension] === undefined) return { recommendation: null, reason: "missing-primary-dimension" };
  if (first.confidence === "low") return { recommendation: null, reason: "insufficient-evidence" };
  if (first.equivalent_registration_ids.length > 1) return { recommendation: null, reason: "equivalent-route-tie" };
  const second = candidates[1];
  if (second && second.selection_score - first.selection_score < MATERIALITY_THRESHOLD) {
    return { recommendation: null, reason: "material-tie" };
  }
  return {
    recommendation: first.registration_id,
    reason: second ? "materially-better" : "only-eligible-candidate",
  };
}

export async function loadModelIntelligence(
  taskType: TeammateTaskType,
  models: readonly AvailableModelIdentity[],
  options: LoadModelIntelligenceOptions = {},
): Promise<ModelIntelligenceView> {
  const loaded = await loadCache(options);
  const preference = options.preference ?? "balanced";
  const dimensions = selectionDimensions(taskType, preference);
  const weights = dimensionWeights(dimensions);
  const emptySelection = (reason: ModelIntelligenceRecommendationReason): NonNullable<ModelIntelligenceView["selection"]> => ({
    method: "weighted-normalized-rank",
    dimension_weights: weights,
    materiality_threshold: MATERIALITY_THRESHOLD,
    recommendation_reason: reason,
    loaded_dimensions: [],
    missing_dimensions: [...MODEL_INTELLIGENCE_DIMENSIONS],
    coverage: {
      available_models: models.length,
      matched_models: 0,
      unmatched_models: models.length,
      distinct_benchmarks: 0,
      returned_candidates: 0,
    },
  });
  if (!loaded.cache) {
    return {
      status: "unavailable",
      task_type: taskType,
      preference,
      recommendation: null,
      selection: emptySelection("no-candidates"),
      candidates: [],
      unmatched_models: models.map((model) => model.registrationId),
      sources: [],
      note: "No current or cached benchmark snapshot is available; retain configured routing.",
    };
  }

  const candidates: ScoredCandidate[] = [];
  const unmatched: string[] = [];
  for (const model of models) {
    const candidate = candidateFor(model, models, loaded.cache.lists, weights);
    if (candidate) candidates.push(candidate);
    else unmatched.push(model.registrationId);
  }
  candidates.sort(compareCandidates);
  const distinct = distinctBenchmarkCandidates(candidates);
  const selected = recommendationFor(distinct, loaded.stale, dimensions[0]!);
  const limit = Math.max(1, Math.min(10, options.limit ?? 5));
  const visible = distinct.slice(0, limit);
  const fetchedAt = loaded.cache.fetchedAt;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const loadedDimensions = MODEL_INTELLIGENCE_DIMENSIONS.filter((dimension) => loaded.cache?.lists[dimension]);
  const missingDimensions = MODEL_INTELLIGENCE_DIMENSIONS.filter((dimension) => !loaded.cache?.lists[dimension]);
  return {
    status: loaded.stale ? "stale" : "available",
    task_type: taskType,
    preference,
    recommendation: selected.recommendation,
    selection: {
      method: "weighted-normalized-rank",
      dimension_weights: weights,
      materiality_threshold: MATERIALITY_THRESHOLD,
      recommendation_reason: selected.reason,
      loaded_dimensions: loadedDimensions,
      missing_dimensions: missingDimensions,
      coverage: {
        available_models: models.length,
        matched_models: candidates.length,
        unmatched_models: unmatched.length,
        distinct_benchmarks: distinct.length,
        returned_candidates: visible.length,
      },
    },
    candidates: visible,
    unmatched_models: unmatched,
    sources: [{
      id: "openrouter-models-api",
      url: options.baseUrl ?? OPENROUTER_MODELS_URL,
      fetched_at: new Date(fetchedAt).toISOString(),
      expires_at: new Date(fetchedAt + ttlMs).toISOString(),
      reference_only: true,
    }],
    note: `External ranks and prices are untrusted advisory OpenRouter reference data ranked for the ${preference} preference; availability, configured routing, and explicit user choices remain authoritative.`,
  };
}
