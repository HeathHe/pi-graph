export interface McpTemplate {
    id: number;
    name: string;
    description?: string;
    serverConfig: {
        command: string;
        args?: string[];
        env?: Record<string, string>;
    };
    tags?: string[];
    category?: string;
    createdAt: number;
    updatedAt: number;
}
export declare function saveTemplate(input: Omit<McpTemplate, 'id' | 'createdAt' | 'updatedAt'> & {
    createdAt?: number;
}): Promise<{
    success: boolean;
    id?: number;
    error?: string;
}>;
export declare function getAllTemplates(): Promise<McpTemplate[]>;
export declare function getTemplateByName(name: string): Promise<McpTemplate | null>;
export declare function getTemplatesByCategory(category: string): Promise<McpTemplate[]>;
export declare function deleteTemplate(name: string): Promise<{
    success: boolean;
    error?: string;
}>;
export declare function searchTemplates(keyword: string): Promise<McpTemplate[]>;
export declare function getAllCategories(): Promise<string[]>;
