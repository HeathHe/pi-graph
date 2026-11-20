import { EventEmitter } from 'node:events';
// ---------------------------------------------------------------------------
// All event types — single source of truth for onAny / offAny
// ---------------------------------------------------------------------------
const ALL_EVENT_TYPES = [
    'board:full',
    'phase:updated',
    'task:updated',
    'scratch:updated',
    'project:updated',
    'watcher:error',
    'heartbeat',
    'connected',
    'agent:spawned',
    'agent:entry',
    'agent:approval',
    'agent:status',
    'agent:stopped',
    'agent:turnCompleted',
    'execution:started',
    'execution:completed',
    'execution:failed',
    'execution:scheduler_status',
    'supervisor:status',
    'supervisor:learning_update',
    'supervisor:schedule_triggered',
    'supervisor:schedule_update',
    'supervisor:extension_loaded',
    'supervisor:extension_error',
    'commander:status',
    'commander:tick',
    'commander:decision',
    'commander:config',
    'commander:assess_metrics',
    'commander:error',
    'coordinate:status',
    'coordinate:analyze_metrics',
    'coordinate:step',
    'coordinate:analysis',
    'coordinate:clarification_needed',
    'coordinate:error',
    'requirement:expanded',
    'requirement:refined',
    'requirement:committed',
    'requirement:progress',
    'workspace:switched',
    'wiki:invalidated',
    'collab:members_updated',
    'collab:activity',
    // Team events
    'team:message',
    'team:dispatch',
    'team:phase',
    'team:agent_status',
    // Room events
    'room:created',
    'room:closed',
    'room:agent_joined',
    'room:agent_left',
    'room:agent_status',
    'room:message',
    'room:broadcast',
    'room:task_created',
    'room:task_updated',
    'room:phase_changed',
    'room:snapshot',
    // Maestro Coordinate events
    'maestro:session_updated',
];
// ---------------------------------------------------------------------------
// Typed event bus wrapping Node.js EventEmitter
// ---------------------------------------------------------------------------
export class DashboardEventBus {
    emitter = new EventEmitter();
    ringBuffer = [];
    maxBufferSize = 1000;
    constructor() {
        // Raise limit — multiple SSE clients may subscribe
        this.emitter.setMaxListeners(50);
    }
    /** Emit a typed dashboard event */
    emit(type, data) {
        const event = {
            type,
            data,
            timestamp: new Date().toISOString(),
        };
        this.emitter.emit(type, event);
        // Append to ring buffer for audit trail
        this.ringBuffer.push(event);
        if (this.ringBuffer.length > this.maxBufferSize) {
            this.ringBuffer.shift();
        }
    }
    /** Get recent events from the ring buffer, optionally filtered by type prefix */
    getRecentEvents(limit = 100, typePrefix) {
        let events = this.ringBuffer;
        if (typePrefix) {
            events = events.filter((e) => e.type.startsWith(typePrefix));
        }
        return events.slice(-limit);
    }
    /** Get current ring buffer size */
    getBufferSize() {
        return this.ringBuffer.length;
    }
    /** Subscribe to a specific event type */
    on(type, listener) {
        this.emitter.on(type, listener);
    }
    /** Unsubscribe from a specific event type */
    off(type, listener) {
        this.emitter.off(type, listener);
    }
    /** Subscribe to all event types */
    onAny(listener) {
        for (const type of ALL_EVENT_TYPES) {
            this.emitter.on(type, listener);
        }
    }
    /** Unsubscribe from all event types */
    offAny(listener) {
        for (const type of ALL_EVENT_TYPES) {
            this.emitter.off(type, listener);
        }
    }
    /** Remove all listeners */
    removeAllListeners() {
        this.emitter.removeAllListeners();
    }
}
//# sourceMappingURL=event-bus.js.map