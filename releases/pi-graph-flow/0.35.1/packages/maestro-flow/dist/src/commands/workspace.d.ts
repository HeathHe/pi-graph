/**
 * Workspace Command — Cross-workspace knowledge sharing management.
 *
 * Subcommands:
 *   maestro workspace link   <path> [--name <n>] [--share spec,knowhow,domain] [--write spec]
 *   maestro workspace unlink <name>
 *   maestro workspace list   [--json]
 *   maestro workspace status [--json]
 *   maestro workspace identity <init|show|reseed>
 */
import type { Command } from 'commander';
export declare function registerWorkspaceCommand(program: Command): void;
//# sourceMappingURL=workspace.d.ts.map