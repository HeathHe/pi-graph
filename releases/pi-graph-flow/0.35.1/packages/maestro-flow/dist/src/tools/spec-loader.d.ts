/**
 * Spec Loader
 *
 * Category-based loading with keyword cross-matching and knowhow tool discovery.
 * Reads .workflow/specs/*.md, filters by category via static mapping,
 * discovers knowhow tools with matching category, returns concatenated content.
 */
export type SpecCategory = 'coding' | 'arch' | 'debug' | 'test' | 'review' | 'learning' | 'ui';
export type SpecScope = 'project' | 'global' | 'team' | 'personal';
export interface SpecLoadResult {
    content: string;
    matchedSpecs: string[];
    totalLoaded: number;
}
export declare const CATEGORY_MAP: Record<string, SpecCategory>;
export declare const TEAM_SPECS_DIR = ".workflow/collab/specs";
/**
 * Resolve the directory for a given spec scope.
 *
 * | scope      | directory                           |
 * |------------|-------------------------------------|
 * | project    | .workflow/specs/                    |
 * | global     | ~/.maestro/specs/                   |
 * | team       | .workflow/collab/specs/              |
 * | personal   | .workflow/collab/specs/{uid}/        |
 */
export declare function resolveSpecDir(projectPath: string, scope: SpecScope, uid?: string): string;
/**
 * Load spec files from one or more directories.
 *
 * Layer scanning order (lowest → highest priority):
 *   0. ~/.maestro/specs/             (global — when `scope` includes global)
 *   1. .workflow/specs/              (baseline)
 *   2. .workflow/collab/specs/       (team shared — when `uid` is provided)
 *   3. .workflow/collab/specs/{uid}/ (personal — when `uid` is provided)
 *
 * Content from later layers is appended (never replaces earlier content).
 * Each layer's content is prefixed with a header for clarity.
 *
 * @param scope   Controls which extra layers to include beyond baseline.
 *                - 'project': baseline only (default)
 *                - 'global': global + baseline
 *                - 'team': baseline + team shared
 *                - 'personal': baseline + team shared + personal (requires uid)
 *                - undefined: same as 'project'; uid alone still triggers team+personal for backward compat
 */
export interface LoadSpecsOptions {
    /** Override global specs directory (for testing). Defaults to ~/.maestro/specs/ */
    globalDir?: string;
    /** Keyword whitelist: only include entries matching at least one keyword */
    includeKeywords?: string[];
    /** Keyword blacklist: exclude entries matching any of these keywords */
    excludeKeywords?: string[];
    /** Extra spec filenames to include for the category (dynamic CATEGORY_MAP extension) */
    extraSpecFiles?: string[];
    /** Linked repository specs directories (read-only, inserted between global and baseline layers). */
    linkedWorkspaces?: Array<{
        name: string;
        specsDir: string;
        repoId?: string | null;
        repoName?: string;
        workspaceFence?: string;
        includeSpecs?: boolean;
        knowhowDir?: string;
    }>;
    /** Repository against which scoped applicability is evaluated. Null hides scoped entries. */
    applicableRepoId?: string | null;
    /** Targeted linked reads disable local/global layers. Defaults preserve aggregate legacy behavior. */
    includeProject?: boolean;
    includeGlobal?: boolean;
    /** Include deprecated entries for explicit audit/history loading. */
    includeDeprecated?: boolean;
}
export declare function loadSpecs(projectPath: string, category?: SpecCategory, uid?: string, keyword?: string, scope?: SpecScope, options?: LoadSpecsOptions): SpecLoadResult;
export interface ExtraDocsResult {
    content: string;
    count: number;
}
/**
 * Load additional documents from arbitrary paths.
 *
 * Path resolution:
 *   - Starts with `knowhow/` → resolved from `.workflow/knowhow/`
 *   - Otherwise → resolved relative to projectPath
 *
 * Returns concatenated markdown content and loaded count.
 */
export declare function loadExtraDocs(projectPath: string, docPaths?: string[], options?: {
    applicableRepoId?: string | null;
}): ExtraDocsResult;
//# sourceMappingURL=spec-loader.d.ts.map