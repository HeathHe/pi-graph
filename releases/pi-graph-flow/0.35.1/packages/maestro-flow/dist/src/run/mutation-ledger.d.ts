export interface MutationEntry {
    timestamp: string;
    actor: string;
    target: string;
    content_hash: string | null;
    mutation_type: 'write' | 'append' | 'delete' | 'patch';
    run_id: string | null;
}
export declare function ledgerPath(projectRoot: string): string;
export declare function appendMutation(projectRoot: string, entry: Omit<MutationEntry, 'timestamp'>): void;
export declare function logMutation(projectRoot: string, actor: string, targetPath: string, opts?: {
    contentHash?: string;
    mutationType?: MutationEntry['mutation_type'];
    runId?: string;
}): void;
export declare function readLedger(projectRoot: string): MutationEntry[];
//# sourceMappingURL=mutation-ledger.d.ts.map