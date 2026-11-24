export declare const BACKGROUND_STATUS_HEARTBEAT_MS: number;
export interface BackgroundStatusTeammate {
    id: string;
    label: string;
    status: string;
    phase?: string;
    lastActivityAt?: number;
}
export interface BackgroundStatusBashJob {
    id: string;
    command: string;
    status: "running" | "stopping";
    startedAt: number;
}
export interface BackgroundStatusSnapshot {
    teammates: BackgroundStatusTeammate[];
    bashJobs: BackgroundStatusBashJob[];
}
export interface BackgroundStatusHeartbeatMessage {
    content: string;
    details: {
        monitoringOnly: true;
        completion: false;
        observedAt: number;
        teammateIds: string[];
        bashJobIds: string[];
    };
}
interface BackgroundStatusHeartbeatScheduler {
    setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}
export interface BackgroundStatusHeartbeatOptions {
    capture: () => BackgroundStatusSnapshot;
    deliver: (message: BackgroundStatusHeartbeatMessage) => boolean;
    intervalMs?: number;
    now?: () => number;
    scheduler?: BackgroundStatusHeartbeatScheduler;
}
export interface BackgroundStatusHeartbeatController {
    markSessionActive: () => void;
    markSessionSettled: () => void;
    setIntervalMs: (intervalMs: number) => void;
    refresh: () => void;
    reset: () => void;
}
/**
 * Pi 0.86 added native cost-aware prompt-cache warming, which supersedes the
 * heartbeat's cache-preservation purpose. On those versions the heartbeat is
 * disabled and the native warmer takes over.
 */
export declare function supportsNativeCacheWarming(version: string | undefined): boolean;
export declare function createBackgroundStatusHeartbeatForHost(version: string | undefined, options: BackgroundStatusHeartbeatOptions): BackgroundStatusHeartbeatController;
export declare function buildBackgroundStatusHeartbeatMessage(input: BackgroundStatusSnapshot, observedAt?: number): BackgroundStatusHeartbeatMessage;
export declare function createBackgroundStatusHeartbeat(options: BackgroundStatusHeartbeatOptions): BackgroundStatusHeartbeatController;
export {};
