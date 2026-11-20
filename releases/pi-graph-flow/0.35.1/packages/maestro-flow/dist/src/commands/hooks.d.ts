import type { Command } from 'commander';
interface HookGroup {
    matcher?: string;
    hooks: Array<{
        type: string;
        command?: string;
        url?: string;
    }>;
}
export interface ClaudeSettings {
    hooks?: {
        PreToolUse?: HookGroup[];
        PostToolUse?: HookGroup[];
        UserPromptSubmit?: HookGroup[];
        Notification?: HookGroup[];
        SessionStart?: HookGroup[];
        [key: string]: unknown;
    };
    statusLine?: {
        type: string;
        command: string;
    };
    [key: string]: unknown;
}
interface HookDef {
    event: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Notification' | 'SessionStart' | 'Stop' | 'SubagentStart' | 'SubagentStop' | 'SessionEnd' | 'StopCancelled';
    matcher?: string;
    /** Minimum level required to install this hook */
    level: HookLevel;
    /** If true, hook exits silently when no Maestro workspace is found */
    requiresWorkspace?: boolean;
    /** Runner name when different from the def key (multiple defs → one runner) */
    runner?: string;
}
/**
 * Hook installation levels (cumulative):
 * - `none`:     No hooks installed
 * - `minimal`:  Statusline + spec-injector (safe monitoring)
 * - `standard`: + delegate-monitor, team-monitor, telemetry (full monitoring)
 * - `full`:     + workflow-guard (PreToolUse), prompt-guard (UserPromptSubmit)
 */
export type HookLevel = 'none' | 'minimal' | 'standard' | 'full';
export declare const HOOK_LEVELS: readonly HookLevel[];
export declare const HOOK_LEVEL_DESCRIPTIONS: Record<HookLevel, string>;
export declare const HOOK_DEFS: Record<string, HookDef>;
interface CodexHookDef {
    event: 'SessionStart' | 'SessionEnd' | 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'StopCancelled' | 'SubagentStart' | 'SubagentStop';
    matcher?: string;
    level: HookLevel;
    requiresWorkspace?: boolean;
    statusMessage?: string;
    timeout?: number;
    /** Runner name when different from the def key (multiple defs → one runner) */
    runner?: string;
}
export declare const CODEX_HOOK_DEFS: Record<string, CodexHookDef>;
export declare const CODEX_HOOK_LEVEL_DESCRIPTIONS: Record<HookLevel, string>;
export declare const GROK_HOOK_DEFS: Record<string, CodexHookDef>;
export declare const GROK_HOOK_LEVEL_DESCRIPTIONS: Record<HookLevel, string>;
/** Return hook names included at a given level for a specific tool (claude/codex/agy). */
export declare function getHooksForLevel(level: HookLevel, tool?: 'claude' | 'codex' | 'agy'): string[];
/** Return all hook names for a specific tool. */
export declare function getAllHookNames(tool?: 'claude' | 'codex' | 'agy'): string[];
/** Get the hook event and level info for display. */
export declare function getHookInfo(hookName: string, tool?: 'claude' | 'codex' | 'agy'): {
    event: string;
    level: HookLevel;
    matcher?: string;
} | null;
export declare function getClaudeSettingsPath(): string;
export declare function loadClaudeSettings(settingsPath: string): ClaudeSettings;
/**
 * Remove maestro hooks from Claude settings.
 *
 * @param settings  Parsed settings.json object (mutated in place)
 * @param hookNames Optional whitelist of hook names to remove. When omitted,
 *                  every maestro-shaped hook command is stripped (see
 *                  commandLooksLikeMaestro).
 */
export declare function removeMaestroHooks(settings: ClaudeSettings, hookNames?: string[]): void;
/**
 * Remove the maestro-installed statusline from Claude settings.
 * Returns true if a statusline was removed.
 */
export declare function removeClaudeStatusline(settingsPath: string): boolean;
/**
 * Uninstall hooks recorded under a HookRecord from a Claude settings file.
 * Removes only the hooks listed in `installed` — does NOT strip statusline.
 * Returns the number of hook entries removed.
 */
export declare function uninstallClaudeHooks(settingsPath: string, installed: string[]): number;
export interface InstallHooksResult {
    settingsPath: string;
    installedHooks: string[];
    level: HookLevel;
}
/**
 * Detect whether a statusline is already configured in Claude Code settings.
 * Returns the current command string if found, or null.
 */
export declare function detectStatusline(opts?: {
    project?: boolean;
}): string | null;
/**
 * Install the statusline into Claude Code settings.json
 * and persist theme preference to maestro config.
 */
export declare function installStatusline(opts?: {
    project?: boolean;
    settingsPath?: string;
    theme?: string;
}): string;
/**
 * Install hooks at the given level into Claude Code settings.json.
 * @param level  Hook level to install
 * @param opts   `project` to use project-scoped settings, otherwise global
 */
export declare function installHooksByLevel(level: HookLevel, opts?: {
    project?: boolean;
    settingsPath?: string;
    skipStatusline?: boolean;
    selectedHooks?: string[];
}): InstallHooksResult;
interface CodexHookGroup {
    matcher?: string;
    hooks: Array<{
        type: string;
        command?: string;
        url?: string;
        statusMessage?: string;
        timeout?: number;
    }>;
}
interface CodexHooksFile {
    hooks?: {
        SessionStart?: CodexHookGroup[];
        PreToolUse?: CodexHookGroup[];
        PostToolUse?: CodexHookGroup[];
        UserPromptSubmit?: CodexHookGroup[];
        Stop?: CodexHookGroup[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export declare function getCodexHooksPath(opts?: {
    project?: boolean;
}): string;
export declare function loadCodexHooks(hooksPath: string): CodexHooksFile;
export declare function removeCodexMaestroHooks(hooksFile: CodexHooksFile, hookNames?: string[]): void;
/**
 * Uninstall codex hooks recorded under a HookRecord. Returns number of entries removed.
 */
export declare function uninstallCodexHooks(hooksPath: string, installed: string[]): number;
/**
 * Check whether `codex_hooks = true` is set in config.toml.
 * Returns true if the flag is found; prints a hint otherwise.
 */
export declare function checkCodexHooksFeatureFlag(opts?: {
    project?: boolean;
}): boolean;
/**
 * Install hooks at the given level into Codex hooks.json.
 */
export declare function installCodexHooksByLevel(level: HookLevel, opts?: {
    project?: boolean;
    hooksPath?: string;
    selectedHooks?: string[];
    defs?: Record<string, CodexHookDef>;
}): InstallHooksResult;
type CodexEvent = 'SessionStart' | 'SessionEnd' | 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop' | 'StopCancelled' | 'SubagentStart' | 'SubagentStop';
export interface GenericHooksPlatform {
    id: string;
    label: string;
    supportedEvents: Set<CodexEvent>;
    hooksPath: (opts: {
        project?: boolean;
    }) => string;
    /** 平台专属 hook defs（默认复用 CODEX_HOOK_DEFS）；grok 使用 GROK_HOOK_DEFS */
    defs?: Record<string, CodexHookDef>;
}
export declare const GENERIC_HOOKS_PLATFORMS: GenericHooksPlatform[];
export declare function getGenericHooksPlatform(platformId: string): GenericHooksPlatform | undefined;
export declare function installGenericHooksByLevel(platformId: string, level: HookLevel, opts?: {
    project?: boolean;
    selectedHooks?: string[];
}): InstallHooksResult;
export declare function getGenericHooksForLevel(platformId: string, level: HookLevel): string[];
/** Antigravity hook event names. */
type AgyEvent = 'PreToolUse' | 'PostToolUse' | 'PreInvocation' | 'PostInvocation' | 'Stop';
interface AgyHookDef {
    event: AgyEvent;
    matcher?: string;
    level: HookLevel;
    requiresWorkspace?: boolean;
    timeout?: number;
}
/**
 * Maestro → Antigravity event mapping.
 *
 * Agy has no SessionStart / UserPromptSubmit. The closest analog is
 * PreInvocation (fires before every model call). The runners that previously
 * targeted UserPromptSubmit / SessionStart are remapped to PreInvocation and
 * rely on workspace-state checks to be cheap on repeated firings.
 *
 * Tool matchers use agy tool names (not Claude's): run_command, write_to_file,
 * replace_file_content, multi_replace_file_content, invoke_subagent, etc.
 */
export declare const AGY_HOOK_DEFS: Record<string, AgyHookDef>;
export declare const AGY_HOOK_LEVEL_DESCRIPTIONS: Record<HookLevel, string>;
interface AgyHookHandler {
    type?: string;
    command: string;
    timeout?: number;
}
interface AgyToolEventEntry {
    matcher?: string;
    hooks: AgyHookHandler[];
}
interface AgyHookConfig {
    enabled?: boolean;
    PreToolUse?: AgyToolEventEntry[];
    PostToolUse?: AgyToolEventEntry[];
    PreInvocation?: AgyHookHandler[];
    PostInvocation?: AgyHookHandler[];
    Stop?: AgyHookHandler[];
}
/** Whole hooks.json file: a flat map of hookName → HookConfig. */
type AgyHooksFile = Record<string, AgyHookConfig>;
/**
 * Resolve the path where Antigravity hooks are configured.
 *   global    → ~/.gemini/config/hooks.json
 *   workspace → <project>/.agents/hooks.json
 *
 * `projectPath` should be the absolute path of the target project; falls back
 * to process.cwd() when omitted (matches the existing Codex pattern).
 */
export declare function getAgyHooksPath(opts?: {
    project?: boolean;
    projectPath?: string;
}): string;
export declare function loadAgyHooks(hooksPath: string): AgyHooksFile;
/** Strip all maestro-prefixed top-level entries (preserves user-defined hooks). */
export declare function removeAgyMaestroHooks(hooksFile: AgyHooksFile, hookNames?: string[]): void;
/**
 * Uninstall agy hooks recorded under a HookRecord. Returns number of entries removed.
 */
export declare function uninstallAgyHooks(hooksPath: string, installed: string[]): number;
/**
 * Install hooks at the given level into Antigravity's hooks.json.
 */
export declare function installAgyHooksByLevel(level: HookLevel, opts?: {
    project?: boolean;
    projectPath?: string;
    hooksPath?: string;
    selectedHooks?: string[];
}): InstallHooksResult;
export declare function registerHooksCommand(program: Command): void;
export {};
//# sourceMappingURL=hooks.d.ts.map