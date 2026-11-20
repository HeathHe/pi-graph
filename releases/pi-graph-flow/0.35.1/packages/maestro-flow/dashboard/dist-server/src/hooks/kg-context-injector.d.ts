/**
 * KG Context Builder — code structure sections for prompt context
 *
 * Injects Knowledge Graph code structure context (callers, callees, exported
 * symbols) using MaestroGraph as the data source. The keyword prompt injector
 * owns composition and budgeting; this module only builds KG sections.
 */
import { type ContextSection } from './context-format.js';
export interface KgInjectionResult {
    inject: boolean;
    content?: string;
    reason?: string;
}
/** Build KG sections for the shared UserPromptSubmit context pipeline. */
export declare function buildKgContextSections(prompt: string, projectPath: string): Promise<ContextSection[]>;
/**
 * Compatibility wrapper for direct consumers. New hook paths should compose
 * buildKgContextSections() with the other prompt context sections instead.
 */
export declare function evaluateKgContextInjection(_agentType: string, prompt: string, projectPath: string): Promise<KgInjectionResult>;
