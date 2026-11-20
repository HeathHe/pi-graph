/**
 * Collaboration adapter interface and registry (team-lite collaboration).
 *
 * Provides a pluggable notification layer that maps collab events to external
 * services (DingTalk, Linear, etc.). Adapters are configured via
 * `.workflow/collab/adapters.json` and instantiated on demand.
 *
 * Fire-and-forget contract: `notifyAdapters()` is synchronous (void return),
 * spawns async work internally, and NEVER throws -- matching the
 * `reportActivity` pattern in `team-activity.ts`.
 *
 * Strict namespace separation: this module belongs to the HUMAN collaboration
 * domain (`.workflow/collab/`).
 */
export type CollabEventType = 'task.created' | 'task.assigned' | 'task.status_changed' | 'task.checked' | 'role.changed';
export interface CollabEvent {
    type: CollabEventType;
    payload: Record<string, unknown>;
    recipients?: string[];
}
export interface CollabAdapter {
    name: string;
    sendNotification(event: CollabEvent): Promise<void>;
    validateConfig(config: Record<string, unknown>): boolean;
}
/**
 * Adapter configuration shape.
 *
 * `enabled` lists adapter names to activate. Every other top-level key holds
 * the per-adapter config block (arbitrary key-value pairs).
 *
 * The index signature uses `unknown` values so that both `Record<string, unknown>`
 * (adapter config blocks) and `string[]` (the `enabled` field) are valid values.
 */
export interface AdapterConfig {
    enabled: string[];
    [adapterName: string]: unknown;
}
/** DingTalk webhook adapter with HMAC-SHA256 signing. */
export declare class DingTalkAdapter implements CollabAdapter {
    readonly name = "dingtalk";
    private webhook;
    private secret;
    validateConfig(config: Record<string, unknown>): boolean;
    sendNotification(event: CollabEvent): Promise<void>;
}
/** Linear GraphQL API adapter. */
export declare class LinearAdapter implements CollabAdapter {
    readonly name = "linear";
    private apiKey;
    private teamId;
    validateConfig(config: Record<string, unknown>): boolean;
    sendNotification(event: CollabEvent): Promise<void>;
}
/** GitHub Issues adapter using REST API v3. */
export declare class GitHubAdapter implements CollabAdapter {
    readonly name = "github";
    private owner;
    private repo;
    private token;
    validateConfig(config: Record<string, unknown>): boolean;
    sendNotification(event: CollabEvent): Promise<void>;
}
/** Slack Incoming Webhook adapter with Block Kit formatting. */
export declare class SlackAdapter implements CollabAdapter {
    readonly name = "slack";
    private webhookUrl;
    private channel;
    validateConfig(config: Record<string, unknown>): boolean;
    sendNotification(event: CollabEvent): Promise<void>;
}
/** Absolute path to the adapter configuration file. */
export declare function getAdaptersConfigPath(): string;
/**
 * Read and parse the adapter config file.
 *
 * Returns `{ enabled: [] }` if the file is missing, empty, or fails to parse.
 * Never throws -- graceful fallback on any I/O or JSON error.
 */
export declare function loadAdapterConfig(): AdapterConfig;
/**
 * Instantiate adapter classes based on the `enabled` array in config.
 *
 * For each name in `config.enabled`:
 *   1. Look up the constructor in the built-in registry.
 *   2. Instantiate and call `validateConfig` with the matching config block.
 *   3. Keep only valid adapters; skip unknown or invalid ones.
 *
 * Returns an empty array when no adapters are configured or valid.
 */
export declare function getEnabledAdapters(config: AdapterConfig): CollabAdapter[];
/**
 * Send a collab event to all enabled adapters.
 *
 * Fire-and-forget: this function is synchronous (returns void), dispatches
 * notifications in parallel via `Promise.allSettled`, and NEVER throws.
 * Individual adapter failures are logged to `console.error`.
 *
 * No-op when no adapters are configured.
 */
export declare function notifyAdapters(event: CollabEvent): void;
