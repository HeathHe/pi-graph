import type { DashboardEventBus } from '../state/event-bus.js';
import type { ExecutionJournal } from '../execution/execution-journal.js';
import type { CommandPattern, KnowledgeEntry, LearningStats } from '../../shared/learning-types.js';
export declare class SelfLearningService {
    private readonly eventBus;
    private readonly journal;
    private readonly patternsPath;
    private readonly kbPath;
    private patterns;
    private knowledgeBase;
    constructor(eventBus: DashboardEventBus, journal: ExecutionJournal, workflowRoot: string);
    /** Full analysis: read all journal events, rebuild pattern stats, generate suggestions */
    analyze(): Promise<LearningStats>;
    /** Get current learning stats snapshot */
    getStats(): LearningStats;
    /** Get all command patterns sorted by frequency (descending) */
    getPatterns(): CommandPattern[];
    /** Get all knowledge base entries */
    getKnowledgeBase(): KnowledgeEntry[];
    /** @deprecated kb.jsonl is being replaced by knowhow markdown (.workflow/knowhow/). Use store_knowhow tool instead. */
    addKnowledgeEntry(entry: Omit<KnowledgeEntry, 'id' | 'usageCount' | 'lastAccessed'>): Promise<KnowledgeEntry>;
    private subscribeToEvents;
    private handleExecutionEvent;
    private rebuildPatterns;
    private generateSuggestions;
    private loadPersistedData;
    private persistPatterns;
    private emitUpdate;
}
