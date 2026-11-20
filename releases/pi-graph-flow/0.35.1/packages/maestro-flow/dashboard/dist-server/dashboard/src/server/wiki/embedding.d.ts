/**
 * Embedding-based semantic search using @huggingface/transformers (ONNX backend).
 *
 * Features:
 * - Smart device detection: auto-benchmarks CPU vs GPU (DirectML), picks fastest
 * - Batch inference: processes documents in configurable batch sizes (4-5x faster)
 * - Incremental indexing: only re-embeds new or changed documents
 * - Graceful degradation: falls back to pure BM25 when transformers is unavailable
 */
import { type SearchFragment } from './structured-fragments.js';
export interface EmbeddingIndex {
    modelId: string;
    dimension: number;
    docIds: string[];
    vectors: Float32Array[];
    /** Parent-document hashes, parallel to vectors (legacy-compatible). */
    contentHashes?: string[];
    chunkDocIds?: string[];
    /** Structured fragment evidence, parallel to docIds when opt-in is enabled. */
    fragments?: SearchFragment[];
    /** Structured chunk policy fence; absent for legacy chunk artifacts. */
    policyChecksum?: string;
    builtAt: number;
    deviceUsed?: string;
    buildTimeMs?: number;
}
export interface VectorSearchResult {
    /** Internal chunk/fragment id; final Wiki results use parentId. */
    docId: string;
    score: number;
    fragment?: SearchFragment;
}
export type DeviceType = 'cpu' | 'gpu';
export type DtypeType = 'fp32' | 'fp16' | 'q8' | 'q4';
export interface DeviceConfig {
    device: DeviceType;
    dtype: DtypeType;
    batchSize: number;
}
export interface EmbeddingApiConfig {
    baseUrl: string;
    apiKey: string;
    model: string;
    dimensions?: number;
    /** Model context window in tokens. Used for dynamic batch sizing. Default: 8192. */
    contextLength?: number;
    /** Fixed batch size (number of texts). Overrides dynamic batching when set. */
    batchSize?: number;
    concurrency?: number;
}
/** Validate and narrow the persisted external embedding API configuration. */
export declare function validateEmbeddingApiConfig(raw: unknown): EmbeddingApiConfig | null;
export interface LocalEmbeddingConfig {
    /** Absolute path to local ONNX model folder (must contain onnx/model.onnx) */
    modelPath: string;
}
export declare function loadLocalEmbeddingConfig(): LocalEmbeddingConfig | null;
export declare function isLocalModelPath(): boolean;
export declare function getLocalModelPath(): string | null;
export declare function loadEmbeddingApiConfig(): EmbeddingApiConfig | null;
export declare function isApiMode(): boolean;
export interface RankedResult {
    docId: string;
    score: number;
}
export interface RRFSignal {
    name: string;
    weight: number;
    results: RankedResult[];
}
export declare function mergeRRFSignals(signals: RRFSignal[], limit: number, k?: number): RankedResult[];
/**
 * Hybrid fusion: RRF for ordering stability + BM25 magnitude for score discrimination.
 * finalScore = alpha * rrfNorm + (1-alpha) * bm25Norm
 */
export declare function mergeHybrid(bm25Results: RankedResult[], vectorResults: RankedResult[], limit: number, options?: {
    k?: number;
    alpha?: number;
    bm25Weight?: number;
    vectorWeight?: number;
}): RankedResult[];
interface BackendInfo {
    name: string;
    bundled: boolean;
}
type OnnxLogLevel = 'verbose' | 'info' | 'warning' | 'error' | 'fatal';
export declare function resolveOnnxLogLevel(value?: string | undefined): OnnxLogLevel;
export declare function configureOnnxRuntimeLogging(): Promise<typeof import('onnxruntime-node')>;
export declare function detectDevice(): Promise<DeviceConfig>;
export declare function getDeviceSummary(): string;
export interface HardwareInfo {
    backends: BackendInfo[];
    gpuAvailable: boolean;
    selectedDevice: DeviceConfig;
    reason: string;
}
export declare function getHardwareInfo(): Promise<HardwareInfo>;
export declare function getModelId(): string;
export declare const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";
/**
 * Check if the local ONNX model is already downloaded in the HuggingFace cache.
 * Returns true for API mode (no local model needed).
 */
export declare function isModelCached(): boolean;
export type ModelProgressCallback = (info: {
    status: string;
    file?: string;
    progress?: number;
    loaded?: number;
    total?: number;
}) => void;
export declare function setProgressCallback(cb: ModelProgressCallback | null): void;
/** Release the process-global Transformers/ONNX pipeline in a dedicated owner process. */
export declare function disposeEmbeddingPipeline(): Promise<void>;
export declare function isAvailable(): Promise<boolean>;
export declare function getUnavailableReason(): string | null;
export declare function embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
export declare function embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array>;
export declare function vectorSearch(queryVector: Float32Array, index: EmbeddingIndex, limit: number, allowedDocIds?: ReadonlySet<string>): VectorSearchResult[];
/**
 * Async vector search using zvec collection.
 * Falls back to flat cosine scan when zvec is unavailable or feature flag is set.
 */
export declare function vectorSearchZvec(queryVector: Float32Array, dir: string, limit: number, fragmentsById?: ReadonlyMap<string, SearchFragment>): Promise<VectorSearchResult[]>;
/** Collapse internal fragment/chunk hits to one highest-scoring parent hit. */
export declare function mapVectorResultsToParents(results: readonly VectorSearchResult[], index: Pick<EmbeddingIndex, 'docIds' | 'chunkDocIds' | 'fragments'>, limit?: number): VectorSearchResult[];
export declare function saveEmbeddingIndex(index: EmbeddingIndex, dir: string, signal?: AbortSignal): Promise<void>;
export declare function loadEmbeddingIndex(dir: string): EmbeddingIndex | null;
export interface DocForEmbedding {
    id: string;
    title: string;
    summary: string;
    tags: string[];
    body?: string;
    /** Optional source metadata used only by structured fragments. */
    kind?: 'markdown' | 'text' | 'code';
    filePath?: string | null;
    symbol?: string | null;
    qualifiedName?: string | null;
    signature?: string | null;
    language?: string | null;
    definition?: string | null;
    sourceType?: string | null;
    startLine?: number;
    endLine?: number;
}
export declare function hashDocContent(d: DocForEmbedding, enrichedText?: string): string;
/**
 * Split a document into multiple chunks for embedding.
 * Short docs (<500 chars body) produce a single chunk.
 * Long docs are split by markdown heading regex /^#{1,3}\s/m, max 5 chunks.
 * Each chunk inherits title+summary as context prefix.
 */
export declare function splitDocToChunks(d: DocForEmbedding): Array<{
    chunkId: string;
    text: string;
    /** Present only for the opt-in structured chunk policy. */
    fragment?: SearchFragment;
}>;
export declare function buildEmbeddingIndex(docs: DocForEmbedding[], existingIndex?: EmbeddingIndex | null, precomputedHashes?: string[], signal?: AbortSignal): Promise<EmbeddingIndex>;
export {};
