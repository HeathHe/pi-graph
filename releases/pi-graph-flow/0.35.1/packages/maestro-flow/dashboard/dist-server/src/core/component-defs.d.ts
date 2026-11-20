export interface ComponentDef {
    id: string;
    label: string;
    description: string;
    sourcePath: string;
    /** Resolve target path based on mode and project path */
    target: (mode: 'global' | 'project', projectPath: string) => string;
    /** Always installs to global location regardless of mode */
    alwaysGlobal: boolean;
    /** Use tag injection instead of file copy (for doc files like CLAUDE.md) */
    inject?: boolean;
    /** Section name for tag injection (default: "core") */
    section?: string;
    /**
     * Default selection on a fresh install (no prior manifest).
     * Omit (undefined) = true (selected by default — backward compat).
     * `false` = opt-in only; user must explicitly tick to install.
     */
    defaultSelected?: boolean;
    /**
     * If true, this component is always installed and cannot be deselected.
     * Core infrastructure components (workflows, templates, overlays, etc.) should be mandatory.
     */
    mandatory?: boolean;
    /**
     * Build callback — when present, the install pipeline calls this instead of
     * copyRecursive. Receives the `.claude` directory (source of truth) and the
     * resolved target directory. Returns file count for stats tracking.
     */
    build?: (claudeDir: string, targetDir: string) => {
        files: number;
    };
    /**
     * Override directory used by `scanComponents` to count source files.
     * When omitted, `sourcePath` is used as before (backward compat).
     */
    sourceCountDir?: string;
    /**
     * Filter for top-level entries in the source directory.
     * When present, only entries where this returns true are copied/counted.
     * Receives the entry name (filename or directory name).
     */
    fileFilter?: (name: string) => boolean;
    /**
     * UI grouping category for ComponentGrid.
     * Components sharing the same category display under a shared header.
     */
    category?: string;
    /**
     * Target platform for this component. Used by TUI to group and filter components.
     * 'shared' = always visible regardless of platform selection.
     * undefined = treated as 'shared' for backward compat.
     */
    platform?: string;
}
export declare const COMPONENT_DEFS: ComponentDef[];
export interface PlatformRegistryEntry {
    id: string;
    label: string;
    description: string;
    /** Config directory name relative to home or project (e.g. '.cursor') */
    configDir: string;
    /** Context file name (default: 'AGENTS.md') */
    contextFile?: string;
    /** Global config directory name when different from configDir (e.g. agy uses .gemini) */
    globalConfigDir?: string;
    /** Context instruction source under workflows/ (default: 'codex-instructions.md') */
    contextSource?: string;
}
export declare const EXTRA_PLATFORMS: PlatformRegistryEntry[];
export declare function migrateComponentIds(ids: string[]): string[];
/**
 * Partition a raw requested component-ID list (e.g. from `--components` or a
 * replayed manifest/profile) into three buckets:
 *  - `unknown`: IDs that name no defined component even after legacy migration
 *    (caller should hard-error on these).
 *  - `unavailable`: IDs that name a defined component but are absent from
 *    `availableIds` — i.e. the component's source files are not present in this
 *    package build (empty source dir, or not shipped). Reinstall/upgrade flows
 *    replay the prior selection, so these must be soft-skipped, not fatal.
 *  - `requested`: the migrated, de-duplicated ID list (defined IDs only).
 */
export declare function partitionRequestedComponentIds(rawIds: string[], availableIds: Set<string>): {
    unknown: string[];
    unavailable: string[];
    requested: string[];
};
/**
 * Migrate old IDs + merge new default-selected components.
 * Used during `maestro update` reinstall so new-version components
 * with `defaultSelected !== false` are automatically included.
 */
export declare function mergeNewDefaults(existingIds: string[], knownIds?: string[]): string[];
