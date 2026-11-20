/** Configure the user-customizable prompts directory */
export declare function setPromptsDir(workflowRoot: string): void;
/** Clear cached prompts (useful after user edits override files) */
export declare function clearPromptCache(): void;
/**
 * Load a prompt template by name.
 * Checks {workflowRoot}/coordinator/prompts/{name}.md first,
 * then falls back to the built-in default.
 */
export declare function loadPrompt(name: string): Promise<string>;
/**
 * List available prompt names from both user and built-in directories.
 * Returns deduplicated names (without .md extension).
 */
export declare function listPrompts(): Promise<{
    name: string;
    source: 'user' | 'builtin';
}[]>;
