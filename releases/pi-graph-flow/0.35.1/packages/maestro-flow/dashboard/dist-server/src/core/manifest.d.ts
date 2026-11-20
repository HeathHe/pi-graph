export interface ManifestEntry {
    path: string;
    type: 'file' | 'dir';
    /** sha256 of the file content as last written by Maestro (inject-managed doc files). */
    hash?: string;
}
/** Claude Code / Codex / Antigravity hook installation record. */
export interface HookRecord {
    /** Absolute path to the settings/hooks config file written. */
    settingsPath: string;
    /** Hook names registered (matches keys in HOOK_DEFS / CODEX_HOOK_DEFS / AGY_HOOK_DEFS). */
    installed: string[];
    /** Level selected at install time (none/minimal/standard/full). */
    level?: string;
}
/** Statusline installation record (Claude Code settings.statusLine). */
export interface StatuslineRecord {
    settingsPath: string;
    /** Theme stored to maestro config; null when no theme was persisted. */
    theme?: string;
}
/** Single MCP server registration record. */
export interface McpRecord {
    /** Absolute path to the config file containing the registration. */
    configPath: string;
    /** Server name under mcpServers / servers key. */
    serverName: string;
}
/** Extra MCP target registration (Cursor / Qoder / Trae / Kiro / Roo / VS Code / Gemini). */
export interface ExtraMcpRecord extends McpRecord {
    targetId: string;
}
export interface Manifest {
    id: string;
    /** Manifest schema version. Bumped when fields change in a backward-incompatible way. */
    version: string;
    scope: 'global' | 'project';
    targetPath: string;
    installedAt: string;
    entries: ManifestEntry[];
    /** Hook level configured during install (none/minimal/standard/full) */
    hookLevel?: string;
    /** Component IDs selected during interactive install (omitted = all) */
    selectedComponentIds?: string[];
    /** Component catalog visible when this manifest was written. */
    knownComponentIds?: string[];
    /** Individually disabled items (type:name format, e.g. "command:odyssey-debug") */
    disabledItems?: string[];
    hooks?: {
        claude?: HookRecord;
        codex?: HookRecord;
        agy?: HookRecord;
        generic?: Record<string, HookRecord>;
    };
    statusline?: StatuslineRecord;
    mcp?: {
        claude?: McpRecord;
        codex?: McpRecord;
        extras?: ExtraMcpRecord[];
    };
    /** Native plugin registration via Claude/Codex plugin CLI */
    plugin?: {
        claude?: boolean;
        codex?: boolean;
    };
}
export declare function manifestFile(id: string): string;
export declare function createManifest(scope: 'global' | 'project', targetPath: string, opts?: {
    hookLevel?: string;
    selectedComponentIds?: string[];
    knownComponentIds?: string[];
}): Manifest;
export declare function addFile(manifest: Manifest, filePath: string, meta?: {
    hash?: string;
}): void;
export declare function addDir(manifest: Manifest, dirPath: string): void;
export declare function recordClaudeHooks(manifest: Manifest, record: HookRecord): void;
export declare function recordCodexHooks(manifest: Manifest, record: HookRecord): void;
export declare function recordAgyHooks(manifest: Manifest, record: HookRecord): void;
export declare function recordGenericHooks(manifest: Manifest, platformId: string, record: HookRecord): void;
export declare function recordStatusline(manifest: Manifest, record: StatuslineRecord): void;
export declare function recordClaudeMcp(manifest: Manifest, record: McpRecord): void;
export declare function recordCodexMcp(manifest: Manifest, record: McpRecord): void;
export declare function uniqueExtraMcpRecords(records: ExtraMcpRecord[] | undefined): ExtraMcpRecord[];
export declare function uniqueExtraMcpTargetIds(records: ExtraMcpRecord[] | undefined): string[];
export declare function recordExtraMcp(manifest: Manifest, record: ExtraMcpRecord): void;
export declare function saveManifest(manifest: Manifest, opts?: {
    expectedPriorId?: string | null;
}): string;
/**
 * 读-改-写在同一把 manifest 锁内完成,并发更新串行化——
 * 不会像 read-merge-save 快照相撞那样丢记录(如 hooks install
 * --target grok 与 --target cursor 并发)。
 */
export declare function updateManifest(scope: Manifest['scope'], targetPath: string, mutate: (manifest: Manifest) => void): string;
export declare function findManifest(scope: 'global' | 'project', targetPath: string): Manifest | null;
export declare function getAllManifests(): Manifest[];
export declare function deleteManifest(manifest: Manifest): void;
/**
 * @param skipContentManaged If true, skip CONTENT_MANAGED files (CLAUDE.md, AGENTS.md).
 *   Use during re-install — tag injection updates in-place, so no cleanup needed.
 *   Default false (full cleanup, used by uninstall).
 */
export declare function cleanManifestFiles(manifest: Manifest, opts?: {
    skipContentManaged?: boolean;
}): {
    removed: number;
    preserved: number;
    skipped: number;
    errors: number;
};
