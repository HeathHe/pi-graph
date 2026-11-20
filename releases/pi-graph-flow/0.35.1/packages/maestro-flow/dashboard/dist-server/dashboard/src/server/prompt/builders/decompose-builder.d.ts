import type { PromptBuilder, PromptContext, PromptResult } from '../prompt-builder.js';
export declare class DecomposePromptBuilder implements PromptBuilder {
    readonly name = "decompose";
    build(context: PromptContext): Promise<PromptResult>;
}
