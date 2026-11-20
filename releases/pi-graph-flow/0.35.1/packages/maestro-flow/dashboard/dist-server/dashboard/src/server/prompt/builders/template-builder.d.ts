import type { PromptBuilder, PromptContext, PromptResult } from '../prompt-builder.js';
export declare class TemplatePromptBuilder implements PromptBuilder {
    readonly name = "template";
    build(context: PromptContext): Promise<PromptResult>;
}
