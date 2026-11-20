export interface CommandPattern {
    command: string;
    frequency: number;
    successRate: number;
    avgDuration: number;
    lastUsed: string;
    contexts: string[];
}
export interface KnowledgeEntry {
    id: string;
    topic: string;
    content: string;
    source: 'auto' | 'manual';
    usageCount: number;
    lastAccessed: string;
    tags: string[];
}
export interface LearningSuggestion {
    type: 'optimize' | 'alert' | 'automate';
    title: string;
    description: string;
    confidence: number;
    action?: string;
}
export interface LearningStats {
    totalCommands: number;
    uniquePatterns: number;
    topPatterns: CommandPattern[];
    suggestions: LearningSuggestion[];
    knowledgeBaseSize: number;
}
