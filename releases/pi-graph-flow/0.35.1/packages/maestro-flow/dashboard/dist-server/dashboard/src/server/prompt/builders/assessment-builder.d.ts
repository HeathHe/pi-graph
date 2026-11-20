import type { PromptBuilder, PromptContext, PromptResult } from '../prompt-builder.js';
export declare class AssessmentPromptBuilder implements PromptBuilder {
    readonly name = "assessment";
    build(context: PromptContext): Promise<PromptResult>;
}
