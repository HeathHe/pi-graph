/**
 * migration-registry.ts — Versioned migration framework for .workflow/ artifacts.
 *
 * Migrations are registered by source→target version pairs.
 * The runner detects the current version from state.json and applies
 * all pending migrations in sequence.
 *
 * Usage:
 *   import { registry, runPendingMigrations } from './migration-registry.js';
 *   registry.register({ from: '1.0', to: '2.0', name: '...', migrate: fn });
 *   const results = runPendingMigrations(workflowRoot);
 */
export interface MigrationDef {
    /** Source version this migration applies to */
    from: string;
    /** Target version after migration */
    to: string;
    /** Human-readable name */
    name: string;
    /** Description of what changes */
    description: string;
    /** The migration function. Receives workflowRoot, returns summary. */
    migrate: (workflowRoot: string) => MigrationResult;
}
export interface MigrationResult {
    success: boolean;
    summary: string;
    changes: string[];
}
export interface MigrationPlan {
    currentVersion: string;
    targetVersion: string;
    steps: MigrationDef[];
}
declare class MigrationRegistry {
    private migrations;
    register(def: MigrationDef): void;
    /** Get all registered migrations sorted by version chain */
    getAll(): readonly MigrationDef[];
    /** Build the migration chain from current version to latest */
    buildPlan(currentVersion: string): MigrationPlan | null;
    /** Get the latest version any migration targets */
    getLatestVersion(): string;
}
export declare const registry: MigrationRegistry;
/** Detect current workflow version from state.json */
export declare function detectVersion(workflowRoot: string): string | null;
/** Plan pending migrations without executing */
export declare function planMigrations(workflowRoot: string): MigrationPlan | null;
/** Execute all pending migrations in sequence */
export declare function runPendingMigrations(workflowRoot: string): {
    plan: MigrationPlan | null;
    results: Array<{
        step: MigrationDef;
        result: MigrationResult;
    }>;
};
/**
 * Load all migrations from src/migrations/index.ts.
 * Call this once at CLI entrypoint to populate the registry.
 * Migrations are decoupled — add new files to src/migrations/ and register in index.ts.
 */
export declare function loadMigrations(): Promise<void>;
export {};
//# sourceMappingURL=migration-registry.d.ts.map