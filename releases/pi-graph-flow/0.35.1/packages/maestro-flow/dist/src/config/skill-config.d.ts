export interface SkillDefaults {
    /** Parameter name → default value */
    params: Record<string, string | boolean | number>;
    /** Last updated timestamp (ISO 8601) */
    updated?: string;
}
export interface SkillConfigFile {
    version: string;
    /** key = skill name (e.g. "execute") */
    skills: Record<string, SkillDefaults>;
}
/**
 * Load skill config with workspace overrides.
 *
 * Priority: {workDir}/.maestro/skill-config.json > ~/.maestro/skill-config.json
 *
 * Merge: per-skill params are deep-merged (workspace overrides same-name params).
 */
export declare function loadSkillConfig(workDir?: string): SkillConfigFile;
/**
 * Synchronous loader for hook context (hooks must be synchronous).
 * Same merge logic as loadSkillConfig.
 */
export declare function loadSkillConfigSync(workDir?: string): SkillConfigFile;
/**
 * Save skill config to the specified scope.
 * Reads existing config, deep-merges the update, and writes back.
 */
export declare function saveSkillConfig(update: Partial<SkillConfigFile>, scope: 'global' | 'workspace', workDir?: string): void;
/**
 * Set a single parameter default for a skill.
 */
export declare function setSkillParam(skill: string, param: string, value: string | boolean | number, scope: 'global' | 'workspace', workDir?: string): void;
/**
 * Remove a single parameter default for a skill.
 */
export declare function unsetSkillParam(skill: string, param: string, scope: 'global' | 'workspace', workDir?: string): void;
/**
 * Reset all defaults for a skill (or all skills).
 */
export declare function resetSkillConfig(skill: string | undefined, scope: 'global' | 'workspace', workDir?: string): void;
/**
 * Get defaults for a specific skill from the merged config.
 * Returns null if no defaults configured.
 */
export declare function getSkillDefaults(skill: string, workDir?: string): SkillDefaults | null;
/**
 * Load global and workspace configs separately (un-merged) for introspection.
 */
export declare function loadSkillConfigSources(workDir?: string): {
    globalPath: string;
    global: SkillConfigFile | null;
    workspacePath: string | null;
    workspace: SkillConfigFile | null;
};
//# sourceMappingURL=skill-config.d.ts.map