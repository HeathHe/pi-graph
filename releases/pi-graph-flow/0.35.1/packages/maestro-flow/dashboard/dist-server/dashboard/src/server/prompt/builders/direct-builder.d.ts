import type { PromptBuilder, PromptContext, PromptResult } from '../prompt-builder.js';
export declare class DirectPromptBuilder implements PromptBuilder {
    readonly name = "direct";
    build(context: PromptContext): Promise<PromptResult>;
}
