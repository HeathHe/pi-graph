interface AgentProcess {
    id: string;
    type: string;
    status: string;
    config: unknown;
    startedAt: string;
    pid?: number;
}
interface NormalizedEntry {
    id: string;
    processId: string;
    timestamp: string;
    type: string;
    [key: string]: unknown;
}
export declare class DashboardBridge {
    private ws;
    private activeCount;
    /**
     * Attempt to connect to the Dashboard WS endpoint.
     * Returns immediately if connection fails or times out.
     */
    tryConnect(url: string, timeoutMs?: number): Promise<boolean>;
    /** Forward a process spawn event to the Dashboard */
    forwardSpawn(process: AgentProcess): void;
    /** Forward a normalized entry to the Dashboard */
    forwardEntry(entry: NormalizedEntry): void;
    /** Register an active CLI process for reference counting */
    registerProcess(): void;
    /** Notify Dashboard that the CLI process has stopped */
    forwardStopped(processId: string): void;
    /** Close the WS connection only when no active processes remain */
    closeIfIdle(): void;
    /** Close the WS connection */
    close(): void;
    private send;
}
export {};
//# sourceMappingURL=dashboard-bridge.d.ts.map