export type StripLegacyGrokAgentsResult = 'stripped' | 'deleted' | 'absent' | 'untouched';
export declare function grokDirFromRulesMaestroPath(dest: string): string | null;
export declare function legacyGrokAgentsPath(grokDir: string): string;
export declare function stripLegacyGrokAgentsMd(filePath: string): StripLegacyGrokAgentsResult;
export declare function stripLegacyGrokAgentsAtGrokDir(grokDir: string): StripLegacyGrokAgentsResult;
