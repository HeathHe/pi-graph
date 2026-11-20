import type { AgentType } from '../../shared/agent-types.js';
export interface ChainStepDef {
    cmd: string;
    args?: string;
}
export declare const INTENT_PATTERNS: Array<[string, RegExp]>;
export declare const CHAIN_MAP: Record<string, ChainStepDef[]>;
export declare const TASK_TO_CHAIN: Record<string, string>;
export declare const AUTO_FLAG_MAP: Record<string, string>;
export declare const STEP_TIMEOUT_MS: number;
/** Classify intent text into a task type using regex patterns */
export declare function detectTaskType(text: string): string;
/** Resolve arg placeholders ({phase}, {description}, {scratch_dir}) */
export declare function resolveArgs(template: string, intent: string, phase: string | null): string;
/** Map tool name string to AgentType */
export declare function resolveAgentType(tool: string | null): AgentType;
