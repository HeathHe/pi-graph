export declare const COOLDOWN_MARKER_MAX_BYTES: number;
export interface CooldownGuardOptions {
    prefix: string;
    cooldownMs: number;
}
export declare class CooldownGuard {
    private readonly prefix;
    private readonly cooldownMs;
    constructor(opts: CooldownGuardOptions);
    shouldRun(sessionId: string): boolean;
    markDone(sessionId: string, extra?: Record<string, unknown>): void;
    timeSinceLastMs(sessionId: string): number | null;
    /** Failed or racing work must remain immediately retryable. */
    clear(sessionId: string): void;
    private read;
    private path;
}
export declare const kgSyncGuard: CooldownGuard;
export declare const kgInitGuard: CooldownGuard;
//# sourceMappingURL=cooldown-guard.d.ts.map