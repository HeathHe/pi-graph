import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
export interface WorkflowGuardResult {
    blocked: boolean;
    reason?: string;
}
export interface PathGuardConfig {
    enabled: boolean;
    mode: 'allow' | 'deny';
    paths: string[];
}
/**
 * Load path guard config from .workflow/config.json → guard section.
 * Returns safe defaults on any failure.
 */
export declare function loadPathGuardConfig(projectRoot: string): PathGuardConfig;
/**
 * Pure evaluation — checks if a file path is within allowed/denied boundaries.
 * Only applies to Write and Edit tools.
 */
export declare function evaluatePathGuard(toolName: string, filePath: string, projectRoot: string, config: PathGuardConfig): WorkflowGuardResult;
/**
 * Pure evaluation function — portable, no I/O dependencies.
 * @param toolName  The tool or command name (e.g. "Bash", "Write")
 * @param input     The command string or tool input to check
 * @param allowlist Tool names that bypass the check
 */
export declare function evaluateWorkflowGuard(toolName: string, input: string, allowlist?: string[]): WorkflowGuardResult;
/** In-process plugin for coordinator graph-walker */
export declare class WorkflowGuard implements MaestroPlugin {
    readonly name = "workflowGuard";
    private readonly allowlist;
    constructor(allowlist?: string[]);
    apply(registry: WorkflowHookRegistry): void;
}
