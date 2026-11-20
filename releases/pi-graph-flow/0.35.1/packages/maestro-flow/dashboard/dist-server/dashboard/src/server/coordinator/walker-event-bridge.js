// ---------------------------------------------------------------------------
// WalkerEventBridge -- bridges GraphWalker events to DashboardEventBus
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// WalkerEventBridge
// ---------------------------------------------------------------------------
export class WalkerEventBridge {
    mode;
    eventBus;
    sessionId;
    constructor(mode, eventBus, sessionId) {
        this.mode = mode;
        this.eventBus = eventBus;
        this.sessionId = sessionId;
    }
    emit(event) {
        // 1. Forward raw walker events to dashboard event bus
        this.eventBus.emit(event.type, event);
        // 2. Translate walker:command → coordinate:step
        if (event.type === 'walker:command') {
            const status = event.status;
            if (this.mode === 'coordinate') {
                // Coordinate mode: emit for ALL statuses (spawned/completed/failed)
                this.eventBus.emit('coordinate:step', {
                    sessionId: event.session_id,
                    step: {
                        cmd: event.cmd ?? event.node_id,
                        status: status === 'completed' ? 'completed'
                            : status === 'failed' ? 'failed'
                                : 'running',
                        summary: event.summary ?? null,
                        qualityScore: event.quality_score ?? null,
                    },
                });
            }
            else {
                // Execution mode: emit ONLY for completed/failed (NOT spawned)
                if (status === 'completed' || status === 'failed') {
                    const sid = this.sessionId ?? event.session_id;
                    this.eventBus.emit('coordinate:step', {
                        sessionId: sid,
                        step: {
                            cmd: event.cmd ?? event.node_id,
                            status: status === 'completed' ? 'completed' : 'failed',
                            summary: event.summary ?? null,
                            qualityScore: null,
                        },
                    });
                }
            }
        }
        // 3. Map gate:waiting → coordinate:clarification_needed
        if (event.type === 'walker:gate_waiting') {
            this.eventBus.emit('coordinate:clarification_needed', {
                sessionId: event.session_id ?? this.sessionId ?? '',
                question: event.wait_message ?? 'Gate condition not met. Waiting for input.',
            });
        }
    }
}
//# sourceMappingURL=walker-event-bridge.js.map