import { type Manifest } from '../core/manifest.js';
import { type MigrateResult } from '../core/tag-injector.js';
import { type ComponentDef } from '../core/component-defs.js';
/** Files to preserve during overwrite */
export declare const PRESERVE_FILES: Set<string>;
export { COMPONENT_DEFS, migrateComponentIds, mergeNewDefaults, partitionRequestedComponentIds, type ComponentDef } from '../core/component-defs.js';
export interface DisabledItem {
    name: string;
    relativePath: string;
    type: 'skill' | 'command' | 'agent';
}
export declare function scanDisabledItems(targetBase: string): DisabledItem[];
export declare function restoreDisabledState(items: DisabledItem[], targetBase: string): number;
export { scanToggleItems, applyToggle, updateManifestDisabledItems, type ToggleItem, type ToggleState, } from '../core/toggle.js';
/**
 * Apply all enabled overlays from ~/.maestro/overlays/ to the just-installed
 * commands. Safe no-op if the overlay dir is missing or empty. Returns the
 * number of overlays successfully applied.
 */
export declare function applyOverlaysPostInstall(scope: 'global' | 'project', targetBase: string): number;
/** MCP server name used everywhere maestro registers itself. */
export declare const MAESTRO_MCP_SERVER_NAME = "maestro-tools";
export declare function getClaudeMcpConfigPath(scope: 'global' | 'project', projectPath: string): string;
export declare function buildMcpRepositoryEnv(projectRoot: string | undefined): Record<string, string>;
/**
 * Register the maestro MCP server in Claude's config. Returns the path that
 * was written on success, or null on failure.
 */
export declare function addMcpServer(scope: 'global' | 'project', projectPath: string, enabledTools: string[], projectRoot?: string): string | null;
export declare function removeMcpServer(scope: 'global' | 'project', projectPath: string): boolean;
/** Remove the maestro-tools entry from a known config file path. */
export declare function removeMcpServerAt(configPath: string): boolean;
/**
 * Enable Codex request-user-input and Multi-Agent V2 defaults. This is an
 * additive user preference: install updates it, uninstall never removes it.
 */
export declare function configureCodexMultiAgentV2(scope: 'global' | 'project', projectPath: string): string | null;
export declare function addCodexMcpServer(scope: 'global' | 'project', projectPath: string, enabledTools: string[], projectRoot?: string): string | null;
export declare function removeCodexMcpServer(scope: 'global' | 'project', projectPath: string): boolean;
export declare function removeCodexMcpServerAt(configPath: string): boolean;
export declare function getPackageRoot(): string;
export declare function countFiles(dir: string): number;
export declare function countFilesFiltered(dir: string, filter: (name: string) => boolean): number;
export interface ScannedComponent {
    def: ComponentDef;
    sourceFull: string;
    targetDir: string;
    fileCount: number;
    available: boolean;
}
export declare function scanComponents(pkgRoot: string, mode: 'global' | 'project', projectPath: string): ScannedComponent[];
export type { CopyStats } from '../core/tag-injector.js';
import type { CopyStats } from '../core/tag-injector.js';
/**
 * Windows: CopyFileW refuses to overwrite a read-only destination
 * (ERROR_ACCESS_DENIED → EPERM). Clear the attribute and retry once.
 * Sources like vendored git pack files carry the read-only bit through
 * the first copy, so every subsequent reinstall hits this path.
 */
export declare function copyFileOverwrite(src: string, dest: string): void;
export declare function copyRecursive(src: string, dest: string, stats: CopyStats, manifest: Manifest, fileFilter?: (name: string) => boolean): void;
/**
 * Remove files in `dest` that do not exist in `src` (after applying the same
 * fileFilter). Prevents stale files from accumulating across installs when
 * source commands/skills/agents are deleted or merged.
 *
 * Only operates on flat or shallow directories — walks recursively but
 * respects PRESERVE_FILES and never removes non-empty directories.
 */
export declare function pruneOrphans(src: string, dest: string, fileFilter?: (name: string) => boolean): number;
export type { MigrateResult } from '../core/tag-injector.js';
/** 注入指令段；若目标是 Grok 的 rules/maestro.md，顺带剥离旧 .grok/AGENTS.md 里的 Maestro 段。 */
export declare function injectDocFile(src: string, dest: string, stats: CopyStats, manifest: Manifest, section?: string): MigrateResult;
export declare function createBackup(manifest: Manifest): string | null;
export interface BackupOptions {
    /** Backup CLAUDE.md files before overwrite (default: true) */
    backupClaudeMd: boolean;
    /** Backup ALL files that will be replaced (default: false) */
    backupAll: boolean;
}
/**
 * Backup existing target files before installation overwrites them.
 * Returns the backup directory path, or null if nothing was backed up.
 */
export declare function createTargetBackup(components: ScannedComponent[], options: BackupOptions): string | null;
/**
 * Count existing files in target directories that would be overwritten.
 */
export declare function countExistingTargetFiles(components: ScannedComponent[]): number;
export declare const MCP_TOOLS: readonly ["write_file", "edit_file", "read_file", "read_many_files", "team_msg", "store_knowhow", "delegate"];
export type ExtraMcpTargetId = 'cursor' | 'qoder' | 'trae' | 'kiro' | 'roo' | 'vscode-copilot' | 'gemini-cli' | 'grok';
export type McpFormat = 'json-mcpServers' | 'json-vscode-servers' | 'json-gemini-merge' | 'toml-mcp-servers';
interface ExtraMcpTargetSpec {
    id: ExtraMcpTargetId;
    label: string;
    format: McpFormat;
    /** Returns the config file path, or null when scope is unsupported. */
    configPath: (scope: 'global' | 'project', projectPath: string) => string | null;
}
export declare const EXTRA_MCP_TARGETS: ExtraMcpTargetSpec[];
export declare function getExtraMcpTargetSpec(targetId: ExtraMcpTargetId): ExtraMcpTargetSpec | undefined;
export declare function addExtraMcpServer(targetId: ExtraMcpTargetId, scope: 'global' | 'project', projectPath: string, enabledTools: string[], projectRoot?: string): string | null;
export declare function removeExtraMcpServer(targetId: ExtraMcpTargetId, scope: 'global' | 'project', projectPath: string): boolean;
export declare function removeExtraMcpServerAt(configPath: string, format: McpFormat): boolean;
export interface UninstallResult {
    filesRemoved: number;
    filesSkipped: number;
    claudeHooksRemoved: number;
    codexHooksRemoved: number;
    agyHooksRemoved: number;
    genericHooksRemoved: Record<string, number>;
    statuslineRemoved: boolean;
    mcpRemoved: {
        claude: boolean;
        codex: boolean;
        extras: string[];
    };
}
export interface UninstallOptions {
    /**
     * Skip CONTENT_MANAGED files (CLAUDE.md, AGENTS.md, maestro.md). Used when uninstalling
     * before a re-install — tag injection updates these in place, so cleanup
     * would lose user content.
     */
    skipContentManaged?: boolean;
    /**
     * Skip deletion of the manifest file itself. Useful when the caller wants
     * to mutate and re-save the manifest as part of a re-install.
     */
    keepManifestFile?: boolean;
}
/**
 * Reverse everything a manifest installed: files, hooks, statusline, MCP.
 *
 * Falls back to legacy "scan for `maestro` marker" cleanup for old manifests
 * (schema < 2.0) that don't have hooks/mcp/statusline records.
 */
export declare function uninstallManifest(manifest: Manifest, opts?: UninstallOptions): UninstallResult;
export interface FallbackScanResult {
    /** Unique target directories that contain files. */
    directories: {
        path: string;
        fileCount: number;
    }[];
    hooksFound: boolean;
    statuslineFound: boolean;
    claudeMcpFound: boolean;
    codexMcpFound: boolean;
    totalFiles: number;
}
/**
 * Scan known maestro target directories for orphaned files when no manifests
 * exist. Uses COMPONENT_DEFS to derive the exact set of directories that
 * maestro install would populate.
 */
export declare function scanFallbackTargets(scope: 'global' | 'project', projectPath: string): FallbackScanResult;
/**
 * Perform a manifest-less cleanup of all known maestro target directories,
 * hooks, MCP, and statusline. Used as fallback when manifests are lost.
 *
 * When `pkgRoot` is provided, source directories are scanned to build a
 * white-list of known (managed) target paths. Only files matching
 * the white-list are deleted — user-added content (e.g. custom workflows
 * like Maestro-publish) is left untouched.
 */
export declare function performFallbackCleanup(scope: 'global' | 'project', projectPath: string, pkgRoot?: string): UninstallResult;
/**
 * Write `[[skills.config]]` entries to `~/.codex/config.toml` to disable
 * .agents/ skills that duplicate the native codex skills.
 * Returns the number of entries written.
 */
export declare function writeCodexSkillDedupeConfig(scope: 'global' | 'project', projectPath: string): number;
/**
 * Remove the managed dedupe block from codex config.
 */
export declare function removeCodexSkillDedupeConfig(scope: 'global' | 'project', projectPath: string): boolean;
//# sourceMappingURL=install-backend.d.ts.map