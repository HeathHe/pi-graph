export interface TemplateMeta {
    name: string;
    category: string;
    path: string;
}
export declare function getPromptsDir(): string;
export declare function getProtocolsDir(): string;
/**
 * Scan the prompts directory and build an in-memory index of templates.
 * Results are cached — call with forceRescan=true to invalidate.
 */
export declare function scanTemplates(forceRescan?: boolean): Promise<Map<string, TemplateMeta>>;
/**
 * Find a template by full name or short name (without category prefix).
 * Returns the TemplateMeta or undefined.
 */
export declare function findTemplate(nameOrShort: string): Promise<TemplateMeta | undefined>;
/**
 * Load a template file content by name (full or short).
 * Returns the file content or null if not found.
 */
export declare function loadTemplate(nameOrShort: string): Promise<string | null>;
/**
 * Load a mode-specific protocol file.
 * Returns the protocol content or null if not found.
 */
export declare function loadProtocol(mode: 'analysis' | 'write'): Promise<string | null>;
/**
 * List all available template names grouped by category.
 */
export declare function listTemplates(): Promise<Record<string, string[]>>;
//# sourceMappingURL=template-discovery.d.ts.map