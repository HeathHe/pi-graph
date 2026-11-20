export declare const CHILD_BUDGET_INTENT = "pi-graph:child-model-request/1";
export declare const childBudgetDigest: (value: unknown) => string;
/** Stable response/token semantics; original entry digests still cover ALL fields. */
export declare function childReceiptDigests(message: unknown): Readonly<{
    messageDigest: string;
    usageDigest: string;
}>;
interface UsageFact {
    request: object;
    entryId: string;
    digest: string;
    units: number;
}
export declare function readChildJournalFact(fact: object, request: object): Readonly<UsageFact>;
/** Launch paths are parent-owned. The ready envelope is only a candidate identity. */
export declare class ChildBudgetJournal {
    #private;
    readonly launch: {
        cwd: string;
        sessionDir?: string;
        resumeSessionFile?: string;
        forkSessionFile?: string;
    };
    constructor(launch: {
        cwd: string;
        sessionDir?: string;
        resumeSessionFile?: string;
        forkSessionFile?: string;
    });
    observeReady(message: Record<string, unknown>): void;
    begin(request: object, claim: string): void;
    bindRequest(cutHandle: object, request: object): void;
    release(request: object): void;
    mark(request: object, entryId: string, digest: string): void;
    fact(request: object, entryId: string, digest: string, terminal: {
        messageDigest: string;
        usageDigest: string;
        provider: string;
        model: string;
        stopReason: string;
    }): object | undefined;
}
export {};
