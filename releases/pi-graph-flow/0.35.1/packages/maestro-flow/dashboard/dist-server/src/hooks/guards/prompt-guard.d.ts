import type { MaestroPlugin } from '../../types/index.js';
import type { WorkflowHookRegistry } from '../workflow-hooks.js';
export interface PromptGuardResult {
    flagged: boolean;
    labels: string[];
    warning?: string;
}
/**
 * Pure evaluation function — portable, no I/O dependencies.
 * @param prompt The user prompt text to scan
 */
export declare function evaluatePromptGuard(prompt: string): PromptGuardResult;
/** In-process plugin for coordinator graph-walker */
export declare class PromptGuard implements MaestroPlugin {
    readonly name = "promptGuard";
    apply(registry: WorkflowHookRegistry): void;
}
