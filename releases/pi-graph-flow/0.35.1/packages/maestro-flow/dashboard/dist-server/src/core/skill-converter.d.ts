export interface BuildStats {
    commands: number;
    skills: number;
    agents: number;
    files: number;
}
/** Maps a Claude tool's parameter name to its platform equivalent. */
interface FieldMapping {
    /** Platform tool name (e.g. 'spawn_agent'). */
    tool: string;
    /** Claude param → platform param. null = dropped, string = renamed. */
    fields: Record<string, string | null>;
    /** Value transforms: 'lowercase_underscore' normalizes name to task_name. */
    transforms?: Record<string, 'lowercase_underscore' | 'identity'>;
    /** Extra params injected on the platform side. */
    inject?: Record<string, string>;
}
export declare const TOOL_FIELD_MAP: Record<string, Record<string, FieldMapping>>;
/**
 * Platform suffix for prepare/workflow override files.
 * e.g. prepare/execute.codex.md takes priority over prepare/execute.md
 * when --platform codex is used at runtime.
 */
export declare const PLATFORM_SUFFIX: Record<string, string>;
/** Supported platform identifiers for runtime content transformation. */
export type TargetPlatform = 'claude' | 'codex' | 'agy' | 'agents-standard' | 'pi' | 'grok' | 'cursor';
/**
 * Runtime content transformer — applies platform-specific tool substitution
 * to raw step/prepare/workflow content without touching the filesystem.
 * `claude` is identity (strips tags only). Used by `maestro run prepare --platform`.
 */
export declare function transformContentForPlatform(content: string, platform: TargetPlatform): string;
export declare function buildAgyTree(claudeDir: string, targetSkillsDir: string, targetAgentsDir: string): BuildStats;
export declare function buildAgentsStandardTree(claudeDir: string, targetSkillsDir: string, targetAgentsDir: string): BuildStats;
/** Build agy skills (commands + skills) only — no agents. */
export declare function buildAgySkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build agy agents only — no skills/commands. */
export declare function buildAgyAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build agents-standard skills (commands + skills) only — no agents. */
export declare function buildAgentsStandardSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build agents-standard agents only — no skills/commands. */
export declare function buildAgentsStandardAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build grok skills (commands + skills) only — no agents. */
export declare function buildGrokSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build grok agents only — no skills/commands. */
export declare function buildGrokAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Cursor skills (commands + skills). Goal stays on Cursor-native /goal. */
export declare function buildCursorSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Cursor agents only — no skills/commands. */
export declare function buildCursorAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Codex skills (commands + skills) — subagent model conversion. */
export declare function buildCodexSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Codex agents as TOML — subagent model conversion. */
export declare function buildCodexAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Codex full tree (skills + agents). */
export declare function buildCodexTree(claudeDir: string, targetSkillsDir: string, targetAgentsDir: string): BuildStats;
/** Build Pi skills (commands + skills) — teammate subagent model. */
export declare function buildPiSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Pi agents — teammate subagent model. */
export declare function buildPiAgents(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Eve skills (commands + skills) with frontmatter stripping & flat file naming. */
export declare function buildEveSkills(claudeDir: string, targetDir: string): {
    files: number;
};
/** Build Eve agents using standard/neutral converter. */
export declare function buildEveAgents(claudeDir: string, targetDir: string): {
    files: number;
};
export {};
