import { SessionStore } from '../store.js';
/**
 * Create the v3 Run directory shell exactly like the v2 lifecycle
 * (ensureRunShell): outputs/, evidence/, work/, a report.md seeded with the
 * shared template, and an append-only diagnostics.ndjson. Idempotent —
 * existing files are never overwritten and the diagnostics stream is only
 * ever appended to (with an empty record, so repeated calls are no-ops).
 */
export declare function ensureV3RunShell(store: SessionStore, sessionId: string, runId: string): string;
//# sourceMappingURL=run-shell.d.ts.map