import { type Command } from 'commander';
/**
 * Check if the skill-context hook is installed in Claude Code settings.
 * Direct file read — no dependency on hooks module to stay ESM-clean.
 */
export declare function checkSkillContextHook(): 'installed' | 'not-installed';
export declare function registerConfigCommand(program: Command): void;
//# sourceMappingURL=config.d.ts.map