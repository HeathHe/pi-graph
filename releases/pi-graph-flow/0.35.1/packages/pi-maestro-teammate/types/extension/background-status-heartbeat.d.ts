import type { BackgroundStatusSnapshot, BackgroundStatusHeartbeatMessage, BackgroundStatusHeartbeatController } from 'pi-graph-observability/execution';
export { BACKGROUND_STATUS_HEARTBEAT_MS, supportsNativeCacheWarming } from 'pi-graph-observability/execution';
export type { BackgroundStatusTeammate, BackgroundStatusBashJob, BackgroundStatusSnapshot, BackgroundStatusHeartbeatMessage, BackgroundStatusHeartbeatController } from 'pi-graph-observability/execution';
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
export declare function createBackgroundStatusHeartbeat(options: BackgroundStatusHeartbeatOptions): BackgroundStatusHeartbeatController;
export declare function createBackgroundStatusHeartbeatForHost(version: string | undefined, options: BackgroundStatusHeartbeatOptions): BackgroundStatusHeartbeatController;
export declare function buildBackgroundStatusHeartbeatMessage(input: BackgroundStatusSnapshot, observedAt?: number): BackgroundStatusHeartbeatMessage;
