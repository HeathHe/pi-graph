// ---------------------------------------------------------------------------
// CoordinateBrokerAdapter — forwards walker events into the file-backed
// delegate broker so external consumers (CLI `watch`, MCP tools, dashboard)
// can stream live progress without polling walker-state.json.
//
// Reuses FileDelegateBroker's generic job/event model:
//   - Each walker session becomes a broker "job" keyed by session_id.
//   - Each CoordinateEvent becomes one job event.
//   - Publishing implicitly creates the job record on the first call, so
//     no explicit registerJob is needed.
//
// The adapter is session-agnostic: it extracts session_id from each event,
// so a single instance can be reused across walker starts without knowing
// the id up front.
//
// Fire-and-forget: publishEvent failures are logged and swallowed. Walker
// progress must never stall on telemetry.
// ---------------------------------------------------------------------------
export class CoordinateBrokerAdapter {
    broker;
    opts;
    constructor(broker, opts = {}) {
        this.broker = broker;
        this.opts = opts;
    }
    emit(event) {
        const sessionId = event.session_id;
        if (!sessionId)
            return;
        try {
            this.broker.publishEvent({
                jobId: sessionId,
                type: event.type,
                payload: toJsonObject(event),
                jobMetadata: this.opts.jobMetadata,
            });
        }
        catch (err) {
            console.error(`[coordinate-broker-adapter] publishEvent failed for ${sessionId}/${event.type}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
// ---------------------------------------------------------------------------
// JSON coercion — CoordinateEvent fields are typed as `unknown` in some
// cases (decision.resolved_value). The broker requires JsonValue; coerce
// unserializable values to their string representation so publishEvent
// never throws on legal walker state.
// ---------------------------------------------------------------------------
function toJsonObject(event) {
    const out = {};
    for (const [key, value] of Object.entries(event)) {
        out[key] = toJsonValue(value);
    }
    return out;
}
function toJsonValue(value) {
    if (value === null || value === undefined)
        return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean')
        return value;
    if (Array.isArray(value))
        return value.map(toJsonValue);
    if (t === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = toJsonValue(v);
        }
        return out;
    }
    return String(value);
}
//# sourceMappingURL=coordinate-broker-adapter.js.map