import { type DelegateBrokerApi } from '../async/index.js';
interface ChannelNotification {
    method: 'notifications/claude/channel';
    params: {
        content: string;
        meta: Record<string, string>;
    };
}
export interface ChannelNotificationServer {
    notification(message: ChannelNotification): Promise<unknown>;
}
export interface DelegateChannelRelayOptions {
    server: ChannelNotificationServer;
    broker?: DelegateBrokerApi;
    sessionId?: string;
    channelId?: string;
    pollIntervalMs?: number;
    pollLimit?: number;
    statusThrottleMs?: number;
    snapshotThrottleMs?: number;
    now?: () => string;
}
export declare class DelegateChannelRelay {
    private readonly server;
    private readonly broker;
    private readonly sessionId;
    private readonly channelId;
    private readonly pollIntervalMs;
    private readonly pollLimit;
    private readonly statusThrottleMs;
    private readonly snapshotThrottleMs;
    private readonly now;
    private readonly jobState;
    private pollTimer;
    private running;
    private polling;
    private consecutiveFailures;
    constructor(options: DelegateChannelRelayOptions);
    get id(): string;
    private get sessionFilePath();
    private writeSessionFile;
    private cleanupSessionFile;
    /** Remove stale relay session files from previous relay processes sharing the
     *  same SSE port. Without this, PID reuse on Windows can make dead relay PIDs
     *  appear alive, causing resolveRelaySessionId() to return the wrong session. */
    private cleanupStaleRelayFiles;
    start(): Promise<void>;
    stop(): void;
    pollOnce(): Promise<void>;
    private drainExistingEvents;
    private handleEvent;
    private shouldEmit;
}
export {};
//# sourceMappingURL=delegate-channel-relay.d.ts.map