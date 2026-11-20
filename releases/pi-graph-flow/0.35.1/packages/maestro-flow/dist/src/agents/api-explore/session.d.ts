import type { ExploreResult } from './runner.js';
export interface ExploreSession {
    id: string;
    startedAt: string;
    cwd: string;
    prompts: string[];
    endpoints: string[];
    totalJobs: number;
    concurrency: number;
    maxTurns: number;
    durationMs: number;
    results: ExploreResult[];
    moa?: {
        preset: string;
        referenceEndpoints: string[];
        results: Array<{
            prompt: string;
            degraded: boolean;
            content: string;
            referenceSummaries: Array<{
                endpointName: string;
                model: string;
                ok: boolean;
                error?: string;
            }>;
        }>;
    };
}
export declare function generateSessionId(): string;
export declare function saveSession(session: ExploreSession, outputDir?: string): string;
export declare function loadSession(cwd: string, sessionId: string, outputDir?: string): ExploreSession | null;
export declare function listSessions(cwd: string, outputDir?: string): Array<{
    id: string;
    startedAt: string;
    prompts: number;
    durationMs: number;
}>;
//# sourceMappingURL=session.d.ts.map