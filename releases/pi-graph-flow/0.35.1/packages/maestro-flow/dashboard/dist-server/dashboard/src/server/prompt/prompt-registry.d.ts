import type { PromptBuilder } from './prompt-builder.js';
export declare class PromptRegistry {
    private readonly builders;
    register(builder: PromptBuilder): void;
    get(name: string): PromptBuilder | undefined;
    list(): string[];
    static createDefault(): PromptRegistry;
}
