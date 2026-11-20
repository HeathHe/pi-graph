import type { EmbeddingStatus } from './EmbeddingConfig.js';
export declare function getEmbeddingStatus(projectRoot: string): Promise<EmbeddingStatus>;
export declare function downloadLocalModel(onProgress?: (pct: number) => void): Promise<void>;
export declare function switchToApiMode(config: {
    baseUrl: string;
    apiKey: string;
    model: string;
    contextLength?: number;
    concurrency?: number;
}): void;
export declare function switchToLocalMode(): void;
//# sourceMappingURL=embedding-status.d.ts.map