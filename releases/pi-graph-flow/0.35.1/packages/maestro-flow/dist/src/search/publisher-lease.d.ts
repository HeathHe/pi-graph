/**
 * A process-wide lease for the one persistent wiki-cache publisher.
 *
 * The lease is deliberately a small, independently-owned file rather than a
 * lock held by a JavaScript process.  `open(..., 'wx')` is the linearization
 * point: a daemon and a one-shot Dashboard publisher can never both believe
 * that they own publication.  Release is compare-and-delete, so a delayed
 * cleanup from an old owner cannot remove a successor's lease.
 */
export declare const WIKI_PUBLISHER_LEASE_FILE = "wiki-index-publisher.lock";
export interface WikiPublisherLease {
    readonly path: string;
    readonly token: string;
    readonly serialized: string;
    release(): void;
}
export interface WikiPublisherLeaseRecord {
    pid: number;
    token: string;
    startedAt: string;
}
/**
 * Acquire the publisher lease, reclaiming only a provably stale owner.
 *
 * Malformed or unreadable lease files are treated as held (fail closed). A
 * dead owner is reclaimed under a short secondary `wx` guard, and the target
 * contents are compared immediately before unlinking. This prevents a stale
 * reclaimer from deleting a fresh daemon lease that won the race.
 */
export declare function acquireWikiPublisherLease(workflowRoot: string): WikiPublisherLease | null;
/** Return the canonical lease path for diagnostics/tests. */
export declare function getWikiPublisherLeasePath(workflowRoot: string): string;
/** Read the current lease owner without mutating it. */
export declare function readWikiPublisherLease(workflowRoot: string): WikiPublisherLeaseRecord | null;
/** Remove a lease only when its serialized owner still matches. */
export declare function releaseWikiPublisherLease(lease: WikiPublisherLease | null | undefined): void;
/**
 * A cheap existence check used by readers that must avoid publication. It is
 * intentionally conservative: an unreadable file still counts as held.
 */
export declare function hasWikiPublisherLease(workflowRoot: string): boolean;
//# sourceMappingURL=publisher-lease.d.ts.map