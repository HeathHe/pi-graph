export interface SkillParamDef {
    /** Parameter name as in argument-hint (e.g. "--auto-commit", "-y", "phase") */
    name: string;
    /** Derived type */
    type: 'boolean' | 'enum' | 'string' | 'number';
    /** Allowed values for enum type */
    choices?: string[];
    /** Short alias (e.g. "-y") */
    alias?: string;
    /** True for positional args */
    positional?: boolean;
    /** True if <required>, false if [optional] */
    required?: boolean;
}
export interface CommandDef {
    /** Command name from frontmatter */
    name: string;
    /** Raw argument-hint string */
    argumentHint: string;
    /** One-line description */
    description: string;
    /** Parsed parameter definitions */
    params: SkillParamDef[];
}
/**
 * Parse an argument-hint string into structured parameter definitions.
 */
export declare function parseArgumentHint(hint: string): SkillParamDef[];
/**
 * Load all command definitions from a `.claude/commands/` directory.
 * Returns a Map of command name → CommandDef.
 */
export declare function loadCommandDefs(commandsDir: string): Map<string, CommandDef>;
/**
 * Discover command directories — checks both global and project-scoped locations.
 * Returns array of existing directories.
 */
export declare function discoverCommandDirs(projectDir?: string): string[];
/**
 * Load all command definitions from all discoverable directories.
 * Project-scoped commands override global ones with the same name.
 */
export declare function loadAllCommandDefs(projectDir?: string): Map<string, CommandDef>;
/**
 * Get only the configurable (non-positional) parameters for a skill.
 * These are the params users typically want to set defaults for.
 */
export declare function getConfigurableParams(params: SkillParamDef[]): SkillParamDef[];
//# sourceMappingURL=argument-hint-parser.d.ts.map