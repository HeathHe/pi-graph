import type { Issue } from '../../shared/issue-types.js';
export declare function withIssueWriteLock<T>(fn: () => Promise<T>): Promise<T>;
/** Generate a unique issue ID: ISS-{timestamp_base36}-{random_4char} */
export declare function generateIssueId(): string;
/**
 * Resolve the issues.jsonl path for a workflow root.
 * Primary: <root>/issues/issues.jsonl
 * Fallback: <root>/issues.jsonl (older sandbox layout)
 */
export declare function resolveIssuesJsonlPath(workflowRoot: string): Promise<string>;
/** Read all issues from a JSONL file. Returns [] if file does not exist. */
export declare function readIssuesJsonl(filePath: string): Promise<Issue[]>;
/** Write all issues to a JSONL file (one JSON object per line). */
export declare function writeIssuesJsonl(filePath: string, issues: Issue[]): Promise<void>;
/** Append a single issue to the JSONL file. */
export declare function appendIssueJsonl(filePath: string, issue: Issue): Promise<void>;
