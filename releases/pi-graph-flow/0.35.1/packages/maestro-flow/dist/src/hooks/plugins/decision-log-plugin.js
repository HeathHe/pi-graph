// ---------------------------------------------------------------------------
// DecisionLogPlugin — Persists decision node outcomes to NDJSON log
// ---------------------------------------------------------------------------
import { appendLine } from '../../utils/jsonl-log.js';
let seq = 0;
export class DecisionLogPlugin {
    logPath;
    name = 'decisionLog';
    constructor(logPath) {
        this.logPath = logPath;
    }
    apply(registry) {
        registry.onDecision.tap(this.name, (ctx) => {
            const entry = {
                id: `DEC-${Date.now()}-${++seq}`,
                timestamp: new Date().toISOString(),
                source: 'coordinate',
                node_id: ctx.nodeId,
                type: 'routing',
                verdict: ctx.target,
                resolved_value: ctx.resolvedValue,
                summary: typeof ctx.resolvedValue === 'string' ? ctx.resolvedValue : '',
            };
            appendLine(this.logPath, entry);
        });
    }
}
//# sourceMappingURL=decision-log-plugin.js.map