// ---------------------------------------------------------------------------
// TelemetryPlugin — Collects timing and outcome data from workflow execution
// ---------------------------------------------------------------------------
export class TelemetryPlugin {
    name = 'telemetry';
    entries = [];
    apply(registry) {
        registry.afterNode.tap(this.name, (ctx, outcome) => {
            this.entries.push({
                type: 'node_exit',
                nodeId: ctx.nodeId,
                timestamp: Date.now(),
                data: { outcome },
            });
        });
        registry.afterCommand.tap(this.name, (ctx) => {
            this.entries.push({
                type: 'command_result',
                nodeId: ctx.nodeId,
                timestamp: Date.now(),
                data: { cmd: ctx.cmd, success: ctx.result.success },
            });
        });
        registry.onError.tap(this.name, (ctx) => {
            this.entries.push({
                type: 'error',
                nodeId: ctx.nodeId,
                timestamp: Date.now(),
                data: { message: ctx.error.message },
            });
        });
    }
    /** Return collected telemetry entries. */
    getEntries() {
        return this.entries;
    }
    /** Clear collected entries. */
    clear() {
        this.entries = [];
    }
}
//# sourceMappingURL=telemetry-plugin.js.map