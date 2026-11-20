import type { WikiEntry } from './wiki-types.js';
import type { WikiIndexer } from './wiki-indexer.js';
export type WritableType = 'spec' | 'knowhow';
export interface CreateWikiReq {
    type: WritableType;
    slug: string;
    title: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    /** Content category (persisted to frontmatter). */
    category?: string;
    /** Creating command/skill name (persisted to frontmatter). */
    createdBy?: string;
    /** Source anchor: session ID, harvest fragment ID, etc. (persisted to frontmatter). */
    sourceRef?: string;
    /** Parent entry ID (persisted to frontmatter). */
    parent?: string;
}
export interface UpdateWikiReq {
    title?: string;
    body?: string;
    frontmatter?: Record<string, unknown>;
    /** sha256 of the previous file bytes for optimistic concurrency. */
    expectedHash?: string;
}
export interface AppendEntryReq {
    /** Container entry ID, e.g. "spec-learnings". */
    containerId: string;
    /** Entry category (coding, arch, debug, learning, etc.). Optional — merged into keywords if provided. */
    category?: string;
    /** Entry content (markdown body, without the <spec-entry> wrapper). */
    content: string;
    /** Optional keywords (comma-separated or array). */
    keywords?: string[] | string;
    /** Explicit title. Falls back to first line of content. */
    title?: string;
    /** One-line description for search results. Falls back to content[:240]. */
    description?: string;
}
export declare class WikiWriteError extends Error {
    code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN';
    details?: unknown | undefined;
    constructor(code: 'BAD_REQUEST' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN', message: string, details?: unknown | undefined);
}
/**
 * WikiWriter — safe CRUD for real markdown wiki entries.
 *
 * Scope: only `spec | knowhow` entries backed by real `.md`
 * files. Virtual entries (issue), and the top-level `project.md` /
 * `roadmap.md` narratives are rejected.
 *
 * All writes invalidate the indexer cache on success so the next read
 * rebuilds. fs-watcher will fire its own `wiki:invalidated` event for the
 * same change; the single-flight guard on `WikiIndexer.rebuild()` prevents
 * duplicate work.
 */
export declare class WikiWriter {
    private readonly workflowRoot;
    private readonly indexer;
    /** Per-path serializer: chains async writes so TOCTOU hash checks are safe. */
    private readonly pathLocks;
    constructor(workflowRoot: string, indexer: WikiIndexer);
    /**
     * Serialize async operations touching the same `key`. Each caller's fn runs
     * after the previous one's promise settles, so read-modify-write sequences
     * don't interleave for a single path.
     */
    private withLock;
    create(req: CreateWikiReq): Promise<WikiEntry>;
    update(id: string, req: UpdateWikiReq): Promise<WikiEntry>;
    remove(id: string): Promise<void>;
    /**
     * Append a `<spec-entry>` block to an existing spec container file.
     * Uses per-path locking, surfaces keywords to frontmatter, and
     * invalidates the wiki index. Returns the new sub-node WikiEntry.
     */
    appendEntry(req: AppendEntryReq): Promise<WikiEntry>;
    /**
     * Remove a spec sub-entry by its ID (e.g. `spec-learnings-003`).
     * Locates the `<spec-entry>` block or heading section in the container
     * file and surgically removes it.
     */
    removeEntry(entryId: string): Promise<void>;
    private assertWritableType;
    private resolveTargetPath;
    private isInsideRoot;
    private isWritablePath;
    private isSpecPath;
    private isKnowhowPath;
}
export declare function serializeFrontmatter(fm: Record<string, unknown>): string;
export declare function splitFrontmatterAndBody(raw: string): {
    frontmatter: Record<string, unknown>;
    body: string;
};
