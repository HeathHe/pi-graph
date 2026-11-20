import type { SessionStore } from './store.js';
export declare const CHANNEL_SCHEMA_VERSION: "knowledge-channel/1.0";
/** Generous idle cap: hook events refresh; expiry only fails writes closed. */
export declare const CHANNEL_TTL_MS: number;
/** Mirrors the plugin WorkflowLeaseStore staleAfterMs. */
export declare const LEASE_STALE_MS = 30000;
export declare const MAESTRO_CHANNEL_ENV = "MAESTRO_CHANNEL";
export declare const PI_HOST_SESSION_ENV = "PI_HOST_SESSION_ID";
export type ChannelHostKind = 'pi' | 'hook' | 'manual';
export interface KnowledgeChannelRecord {
    schema_version: typeof CHANNEL_SCHEMA_VERSION;
    identity: string;
    host_kind: ChannelHostKind;
    /** Bound governance context, if resolved. */
    context: {
        kind: 'session' | 'run';
        session_id: string;
        run_id?: string;
    } | null;
    /** Reserved (MVP always null). */
    workspace_id: string | null;
    /** Reserved for a future CAS upgrade; MVP writes 1. */
    revision: number;
    created_at: string;
    expires_at: string;
    last_seen_at: string;
}
export declare function channelsDir(projectRoot: string): string;
/**
 * Normalize a caller-supplied identity into a safe file segment. Non-empty
 * guaranteed; unsafe characters collapsed; bounded length.
 */
export declare function sanitizeChannelIdentity(raw: string): string;
export declare function channelFilePath(projectRoot: string, identity: string): string;
export declare function readChannel(projectRoot: string, identity: string): KnowledgeChannelRecord | null;
/** Live = parseable, schema-matching, unexpired, and carrying a bound context. */
export declare function listLiveChannels(projectRoot: string, nowMs?: number): KnowledgeChannelRecord[];
/** Atomic-ish write: temp file + rename (same convention as lease claims). */
export declare function writeChannel(projectRoot: string, record: KnowledgeChannelRecord): void;
/**
 * Create or refresh a channel. Existing bound context is preserved unless a
 * new one is supplied; TTL/lastSeen always advance.
 */
export declare function touchChannel(projectRoot: string, opts: {
    identity: string;
    hostKind: ChannelHostKind;
    context?: KnowledgeChannelRecord['context'];
    nowMs?: number;
}): KnowledgeChannelRecord;
export interface LeaseClaim {
    sessionId: string;
    hostSessionId: string;
    epoch: number;
    heartbeatAt: string;
    token: string;
}
/**
 * Read the highest-epoch claim per `.workflow/tmp/hook/<sessionId>.lease/`
 * directory. Corrupt directories are skipped; staleness is judged by the
 * caller against the claim file mtime.
 */
export declare function readLeaseClaims(projectRoot: string): Array<LeaseClaim & {
    claimPath: string;
    mtimeMs: number;
}>;
/** Fresh lease claim for a host session, if any (mtime within LEASE_STALE_MS). */
export declare function findLeaseForHost(projectRoot: string, hostSessionId: string, nowMs?: number): {
    sessionId: string;
    heartbeatAt: string;
    epoch: number;
} | null;
export type WriteAuthorityVia = 'explicit' | 'lease' | 'channel' | 'synthetic' | 'narrowed-scan';
export type WriteAuthority = {
    kind: 'run';
    sessionId: string;
    runId: string;
    via: WriteAuthorityVia;
    identity?: string;
    warning?: string;
} | {
    kind: 'session';
    sessionId: string;
    via: WriteAuthorityVia;
    synthetic: boolean;
    identity?: string;
    warning?: string;
};
export interface ResolveWriteAuthorityInput {
    projectRoot: string;
    store: SessionStore;
    explicitRun?: string;
    explicitSession?: string;
    explicitChannel?: string;
    /** Injectable for tests; defaults to process.env. */
    env?: Record<string, string | undefined>;
    nowMs?: number;
}
/**
 * Resolve where a knowledge write belongs. Tier order per MVP K3:
 * explicit → env channel → Pi host lease → single live channel → narrowed
 * scan → synthetic (nothing running) → fail-closed.
 */
export declare function resolveWriteAuthority(input: ResolveWriteAuthorityInput): WriteAuthority;
export type KnowledgeAttributionAuthority = {
    kind: 'run';
    sessionId: string;
    runId: string;
} | {
    kind: 'session';
    sessionId: string;
};
/**
 * Resolve best-effort load attribution without creating authority. Exact Run
 * channel bindings are retained; divergent channels and multi-Run leases fail
 * closed by returning null.
 */
export declare function findKnowledgeAttributionAuthority(projectRoot: string, store: SessionStore, env?: Record<string, string | undefined>, nowMs?: number): KnowledgeAttributionAuthority | null;
/**
 * Read-only Session ID projection of best-effort attribution authority.
 * Exact Run authority is retained by findKnowledgeAttributionAuthority;
 * this compatibility helper returns only its owning Session. Never creates Sessions.
 */
export declare function findSessionAttributionTarget(projectRoot: string, store: SessionStore, env?: Record<string, string | undefined>, nowMs?: number): string | null;
//# sourceMappingURL=knowledge-identity.d.ts.map