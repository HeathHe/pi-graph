export type MigrateStatus = 'migrated' | 'already-migrated' | 'version-only' | 'migrated-to-2.0';
export interface MigrateResult {
    session_id: string;
    status: MigrateStatus;
    had_ralph_meta: boolean;
    mapped_steps: number;
    target_version?: 'session/1.3' | 'session/2.0';
    legacy_execution_id?: string;
}
/**
 * Merge ralph-meta.json into session.json and stamp the latest Session schema. Idempotent:
 * a session already carrying position or decomposition is treated as migrated
 * and returned untouched. A session with a running chain step is rejected — the
 * caller must complete it first so migration never races an in-flight step.
 */
export declare function migrateSession(projectRoot: string, sessionId: string): MigrateResult;
/**
 * Migrate every session under `.workflow/sessions/`. Each session is migrated
 * independently; a failure on one is captured and reported without aborting the
 * batch.
 */
export declare function migrateAllSessions(projectRoot: string): Array<{
    session_id: string;
    result?: MigrateResult;
    error?: string;
}>;
//# sourceMappingURL=migrate.d.ts.map