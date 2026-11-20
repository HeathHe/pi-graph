export declare const IMPECCABLE_DIR = ".workflow/impeccable";
export declare const LIVE_DIR = "live";
export declare const CRITIQUE_DIR = "critique";
export declare function getImpeccableDir(cwd?: string): string;
export declare function getDesignSidecarPath(cwd?: string): string;
export declare function getDesignSidecarCandidates(cwd?: string, contextDir?: string): string[];
export declare function resolveDesignSidecarPath(cwd?: string, contextDir?: string): string | null;
export declare function getLiveDir(cwd?: string): string;
export declare function getLiveConfigPath(cwd?: string): string;
export declare function getLegacyLiveConfigPath(scriptsDir: string): string;
export interface LiveServerInfo {
    pid: number;
    port: number;
    token: string;
}
export declare function resolveLiveConfigPath(opts?: {
    cwd?: string;
    scriptsDir?: string;
    env?: Record<string, string | undefined>;
}): string | null;
export declare function getLiveServerPath(cwd?: string): string;
export declare function getLegacyLiveServerPath(cwd?: string): string;
export declare function readLiveServerInfo(cwd?: string): {
    info: LiveServerInfo;
    path: string;
} | null;
export declare function writeLiveServerInfo(cwd: string | undefined, info: LiveServerInfo): string;
export declare function removeLiveServerInfo(cwd?: string): void;
export declare function getLiveSessionsDir(cwd?: string): string;
export declare function getLegacyLiveSessionsDir(cwd?: string): string;
export declare function getLiveAnnotationsDir(cwd?: string): string;
export declare function getCritiqueDir(cwd?: string): string;
export declare function getLegacyLiveAnnotationsDir(cwd?: string): string;
//# sourceMappingURL=paths.d.ts.map