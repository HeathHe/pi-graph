export type LiveEventType = 'generate' | 'variants_ready' | 'agent_done' | 'checkpoint' | 'accept' | 'accept_intent' | 'discard' | 'discarded' | 'complete' | 'agent_error';
export interface LiveEvent {
    id?: string;
    type: LiveEventType | string;
    pageUrl?: string;
    count?: number;
    screenshotPath?: string;
    file?: string;
    arrivedVariants?: number;
    carbonize?: boolean;
    revision?: number;
    phase?: string;
    owner?: string;
    visibleVariant?: number;
    paramValues?: Record<string, unknown>;
    variantId?: number;
    message?: string;
    token?: string;
}
export interface JournalEntry {
    seq: number;
    id: string;
    type: string;
    ts: string;
    event: LiveEvent;
}
export interface AnnotationArtifact {
    type: string;
    path: string;
}
export interface DiagnosticEntry {
    error: string;
    line?: number;
    message?: string;
    type?: string;
    revision?: number;
    file?: string | null;
}
export interface LiveSnapshot {
    id: string;
    phase: string;
    pageUrl: string | null;
    sourceFile: string | null;
    expectedVariants: number;
    arrivedVariants: number;
    visibleVariant: number | null;
    paramValues: Record<string, unknown>;
    pendingEventSeq: number | null;
    pendingEvent: LiveEvent | null;
    deliveryLease: unknown | null;
    checkpointRevision: number;
    activeOwner: string | null;
    sourceMarkers: Record<string, unknown>;
    fallbackMode: string | null;
    annotationArtifacts: AnnotationArtifact[];
    diagnostics: DiagnosticEntry[];
    updatedAt: string | null;
}
export interface LiveSessionStore {
    rootDir: string;
    legacyRootDir: string;
    appendEvent(event: LiveEvent): LiveSnapshot;
    getSnapshot(id?: string, opts?: {
        includeCompleted?: boolean;
    }): LiveSnapshot | null;
    listActiveSessions(): LiveSnapshot[];
}
export declare function createLiveSessionStore(opts?: {
    cwd?: string;
    sessionId?: string;
}): LiveSessionStore;
//# sourceMappingURL=session-store.d.ts.map