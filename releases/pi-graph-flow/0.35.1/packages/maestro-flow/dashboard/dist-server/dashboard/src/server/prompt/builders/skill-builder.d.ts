import type { PromptBuilder, PromptContext, PromptResult } from '../prompt-builder.js';
export declare class SkillPromptBuilder implements PromptBuilder {
    readonly name = "skill";
    build(context: PromptContext): Promise<PromptResult>;
}
