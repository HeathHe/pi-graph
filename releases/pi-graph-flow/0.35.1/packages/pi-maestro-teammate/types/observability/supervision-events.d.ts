import type { JournalFactoryBinding, ScopeLease, SupervisionFact } from 'pi-graph-observability';
export declare const OBSERVABILITY_SUPERVISION_EVENT = "pi-graph:supervision-fact:v1";
/** One source sequence per Root incarnation, allocated only by the producer adapter. */
export declare function createSupervisionProducer(capture: () => JournalFactoryBinding | undefined, emit: (name: string, fact: SupervisionFact) => void, source: SupervisionFact['source'], producerKey: string): {
    begin: (kind: SupervisionFact["kind"], operationId: string, detail?: Partial<Pick<SupervisionFact, "target" | "message" | "severity">>) => {
        lease: ScopeLease;
        start: number;
        publish: (extra: Partial<Pick<SupervisionFact, "kind" | "verdict" | "delivery" | "terminalOutcome" | "message" | "target" | "severity">>) => boolean;
        attempt(): boolean;
        settle(result: unknown): boolean;
    } | undefined;
};
