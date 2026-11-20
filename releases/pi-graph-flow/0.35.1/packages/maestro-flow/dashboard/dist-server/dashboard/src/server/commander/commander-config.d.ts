import type { CommanderConfig } from '../../shared/commander-types.js';
export declare const PROFILES: Record<string, Partial<CommanderConfig>>;
/**
 * Apply a profile's preset values, but only for fields that are still at
 * their default value (i.e. not explicitly overridden by project/env layers).
 */
export declare function applyProfile(config: CommanderConfig, profile?: CommanderConfig['profile']): CommanderConfig;
/**
 * Resolve a final CommanderConfig from multiple override layers.
 * Merge order (lowest to highest priority):
 *   defaults -> profile preset -> project -> env -> runtime
 */
export declare function resolveConfig(projectOverride?: Partial<CommanderConfig>, envOverride?: Partial<CommanderConfig>, runtimeOverride?: Partial<CommanderConfig>): CommanderConfig;
/**
 * Load Commander configuration with 5-layer merge:
 *   1. DEFAULT_COMMANDER_CONFIG (built-in)
 *   2. ~/.maestro/commander.json (user global)
 *   3. .workflow/config.json -> commander section (project)
 *   4. COMMANDER_* environment variables
 *   5. Runtime overrides (applied later via updateConfig)
 */
export declare function loadCommanderConfig(workflowRoot: string): Promise<CommanderConfig>;
