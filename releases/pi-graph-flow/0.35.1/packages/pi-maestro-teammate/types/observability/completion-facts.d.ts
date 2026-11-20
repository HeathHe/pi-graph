import type { JournalFactoryBinding, SupervisionFact } from 'pi-graph-observability';
/** Captures are associated with the ORIGINAL admitted publication/message object.
 * Receipt callbacks receive a closure, never an id-to-new-operation lookup.
 * Weak ownership retains no unbounded strong id registry and cannot promote an
 * unknown string id to a new start sequence after a bounded window expires.
 */
export declare function createCompletionFacts(capture: () => JournalFactoryBinding | undefined, emit: (name: string, fact: SupervisionFact) => void, producerKey?: string): {
    publication(original: object, id: string): (acknowledged: boolean, outcome?: "completed" | "failed" | "terminated") => void;
    notification(original: object, id: string): (applied: boolean) => void;
};
export declare function registerCompletionFactsHost(host: object, capture: () => JournalFactoryBinding | undefined, emit: (name: string, fact: SupervisionFact) => void): {
    owner: {
        publication(original: object, id: string): (acknowledged: boolean, outcome?: "completed" | "failed" | "terminated") => void;
        notification(original: object, id: string): (applied: boolean) => void;
    };
    dispose(): void;
};
export declare function capturePublicationObservation(host: object, original: object, id: string | undefined): ((acknowledged: boolean, outcome?: "completed" | "failed" | "terminated") => void) | undefined;
export declare function captureNotificationObservation(host: object, message: object): ((applied: boolean) => void) | undefined;
