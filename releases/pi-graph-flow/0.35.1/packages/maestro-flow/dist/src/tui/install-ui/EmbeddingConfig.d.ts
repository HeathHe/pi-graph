export interface EmbeddingStatus {
    mode: 'local' | 'api';
    modelId: string;
    modelCached: boolean;
    dimension: number;
    device: string;
    dtype: string;
    batchSize: number;
    gpuAvailable: boolean;
    wikiIndexDocs: number;
    wikiIndexBuiltAt: string | null;
    codeIndexNodes: number;
    codeIndexBuiltAt: string | null;
}
interface EmbeddingConfigProps {
    status: EmbeddingStatus | null;
    downloading: boolean;
    downloadProgress: number;
    onDownloadModel: () => void;
    onSwitchMode: (mode: 'local' | 'api') => void;
    onRebuildIndex: () => void;
}
export declare function EmbeddingConfig({ status, downloading, downloadProgress, onDownloadModel, onSwitchMode, onRebuildIndex, }: EmbeddingConfigProps): import("react/jsx-runtime").JSX.Element;
export {};
//# sourceMappingURL=EmbeddingConfig.d.ts.map