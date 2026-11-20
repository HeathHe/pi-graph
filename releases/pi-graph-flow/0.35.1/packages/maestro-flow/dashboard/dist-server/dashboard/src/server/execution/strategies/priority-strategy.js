// ---------------------------------------------------------------------------
// PriorityStrategy — dispatch by issue priority then creation date
// ---------------------------------------------------------------------------
const PRIORITY_ORDER = {
    urgent: 0,
    high: 1,
    medium: 2,
    low: 3,
};
export class PriorityStrategy {
    name = 'priority';
    async selectIssues(context) {
        if (context.availableSlots <= 0)
            return [];
        const candidates = context.issues
            .filter((i) => i.status === 'open' &&
            (!i.execution || i.execution.status === 'idle') &&
            !context.claimed.has(i.id))
            .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
        const decisions = [];
        for (const issue of candidates) {
            if (decisions.length >= context.availableSlots)
                break;
            decisions.push({
                issueId: issue.id,
                executor: issue.executor ?? undefined,
                reason: `priority=${issue.priority}`,
            });
        }
        return decisions;
    }
}
//# sourceMappingURL=priority-strategy.js.map