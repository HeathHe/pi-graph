import { z } from 'zod';
declare const issueSchema: z.ZodObject<{
    id: z.ZodString;
    title: z.ZodString;
    status: z.ZodString;
}, z.core.$loose>;
export type IssueRecord = z.infer<typeof issueSchema>;
export interface IssuePaths {
    root: string;
    active: string;
    history: string;
    lock: string;
    backups: string;
}
export declare function resolveIssuePaths(workflowRoot?: string): IssuePaths;
export declare function readIssueFile(path: string): IssueRecord[];
export declare function createIssue(workflowRoot: string, input: {
    title: string;
    severity: string;
    source: string;
    priority: number;
    description?: string;
    tags?: string[];
}): Promise<IssueRecord>;
export declare function listIssues(workflowRoot: string, includeHistory?: boolean): IssueRecord[];
export declare function getIssue(workflowRoot: string, id: string): IssueRecord | null;
export declare function updateIssue(workflowRoot: string, id: string, updates: Record<string, unknown>, note?: string): Promise<IssueRecord>;
export declare function closeIssue(workflowRoot: string, id: string, status: 'completed' | 'failed' | 'deferred', resolutionText: string): Promise<IssueRecord>;
export declare function linkIssue(workflowRoot: string, id: string, taskId: string): Promise<IssueRecord>;
export declare function issueStoreMtime(workflowRoot: string): number;
export {};
//# sourceMappingURL=store.d.ts.map