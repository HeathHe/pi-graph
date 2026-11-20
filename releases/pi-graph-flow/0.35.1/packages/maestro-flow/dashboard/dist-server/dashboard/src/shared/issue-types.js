// ---------------------------------------------------------------------------
// Issue type system -- types for the Issue tracking feature
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------
export const VALID_ISSUE_TYPES = new Set([
    'bug', 'feature', 'improvement', 'task',
]);
export const VALID_ISSUE_PRIORITIES = new Set([
    'low', 'medium', 'high', 'urgent',
]);
export const VALID_ISSUE_STATUSES = new Set([
    'open', 'registered', 'in_progress', 'resolved', 'closed', 'deferred',
]);
/** Derive the current supplement stage from an issue's status */
export function deriveSupplementStage(issue) {
    switch (issue.status) {
        case 'open': return 'post_creation';
        case 'registered': return 'analysis';
        case 'in_progress': return 'execution';
        case 'resolved': return 'resolution';
        case 'closed': return 'general';
        case 'deferred': return 'general';
        default: return 'general';
    }
}
//# sourceMappingURL=issue-types.js.map