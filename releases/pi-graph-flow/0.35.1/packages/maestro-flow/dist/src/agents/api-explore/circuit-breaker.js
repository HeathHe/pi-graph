/**
 * Per-endpoint circuit breaker for explore jobs.
 *
 * Tracks consecutive failures per endpoint name. When failures reach
 * the configured threshold, the endpoint is marked "open" (tripped)
 * and remaining jobs are re-routed to a fallback endpoint.
 *
 * Supports time-based auto-recovery: tripped endpoints become eligible
 * for retry after `resetAfterMs` (default 1 hour). Persistent state
 * across runs via JSON file.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const DEFAULT_STATE_PATH = join(homedir(), '.maestro', '.explore-circuit-state.json');
export class EndpointCircuitBreaker {
    threshold;
    fallbackOrder;
    resetAfterMs;
    states = new Map();
    onTrip;
    statePath;
    now;
    constructor(config, opts) {
        this.threshold = config?.threshold ?? 3;
        this.fallbackOrder = config?.fallbackOrder ?? [];
        this.resetAfterMs = config?.resetAfterMs ?? 3_600_000;
        this.onTrip = opts?.onTrip;
        this.statePath = opts?.statePath ?? DEFAULT_STATE_PATH;
        this.now = opts?.now ?? Date.now;
        this.loadPersistedState();
    }
    getState(name) {
        let s = this.states.get(name);
        if (!s) {
            s = { consecutiveFailures: 0, open: false };
            this.states.set(name, s);
        }
        return s;
    }
    loadPersistedState() {
        try {
            const raw = readFileSync(this.statePath, 'utf-8');
            const data = JSON.parse(raw);
            const now = this.now();
            for (const [name, info] of Object.entries(data.endpoints ?? {})) {
                if (this.resetAfterMs > 0 && now - info.trippedAt >= this.resetAfterMs)
                    continue;
                this.states.set(name, {
                    consecutiveFailures: this.threshold,
                    open: true,
                    trippedAt: info.trippedAt,
                });
            }
        }
        catch {
            // No state file or invalid — start fresh
        }
    }
    persistState() {
        const endpoints = {};
        for (const [name, state] of this.states) {
            if ((state.open || state.halfOpen) && state.trippedAt) {
                endpoints[name] = { trippedAt: state.trippedAt };
            }
        }
        try {
            mkdirSync(dirname(this.statePath), { recursive: true });
            writeFileSync(this.statePath, JSON.stringify({ endpoints }, null, 2));
        }
        catch {
            // Best-effort persistence
        }
    }
    recordSuccess(endpointName) {
        const s = this.getState(endpointName);
        s.consecutiveFailures = 0;
        if (s.open || s.halfOpen) {
            s.open = false;
            s.halfOpen = false;
            s.trippedAt = undefined;
        }
    }
    /** Record a failure. Returns true if the endpoint just tripped. */
    recordFailure(endpointName) {
        const s = this.getState(endpointName);
        s.consecutiveFailures++;
        if (s.halfOpen || (!s.open && s.consecutiveFailures >= this.threshold)) {
            s.open = true;
            s.halfOpen = false;
            s.trippedAt = this.now();
            this.onTrip?.(endpointName, s.consecutiveFailures);
            return true;
        }
        return false;
    }
    /** Force-trip an endpoint (e.g. after pre-flight probe failure). */
    trip(endpointName) {
        const s = this.getState(endpointName);
        if (s.open)
            return;
        s.open = true;
        s.halfOpen = false;
        s.trippedAt = this.now();
        s.consecutiveFailures = this.threshold;
        this.onTrip?.(endpointName, 0);
    }
    /** Allow one model-level trial while retaining the previous trip for persistence. */
    allowHalfOpenTrial(endpointName) {
        const s = this.getState(endpointName);
        if (!s.open)
            return;
        s.open = false;
        s.halfOpen = true;
        s.consecutiveFailures = 0;
    }
    isOpen(endpointName) {
        const s = this.getState(endpointName);
        if (!s.open)
            return false;
        if (this.resetAfterMs > 0 && s.trippedAt && this.now() - s.trippedAt >= this.resetAfterMs) {
            s.open = false;
            s.halfOpen = false;
            s.consecutiveFailures = 0;
            s.trippedAt = undefined;
            return false;
        }
        return true;
    }
    /**
     * Find a healthy fallback endpoint for a tripped one.
     * Tries fallbackOrder first, then any remaining healthy endpoint.
     */
    selectFallback(trippedName, allEndpoints) {
        return this.getFallbackCandidates(trippedName, allEndpoints)[0] ?? null;
    }
    /** Return healthy fallback endpoints in configured priority order. */
    getFallbackCandidates(trippedName, allEndpoints, excluded = new Set()) {
        const epMap = new Map(allEndpoints.map(ep => [ep.name, ep]));
        const candidates = [];
        const added = new Set();
        const addIfHealthy = (name) => {
            if (name === trippedName || excluded.has(name) || added.has(name))
                return;
            const ep = epMap.get(name);
            if (!ep || this.isOpen(name))
                return;
            added.add(name);
            candidates.push(ep);
        };
        // Try configured fallback order first
        for (const name of this.fallbackOrder) {
            addIfHealthy(name);
        }
        // Try any healthy endpoint not in fallback order
        for (const ep of allEndpoints) {
            addIfHealthy(ep.name);
        }
        return candidates;
    }
    /** Summary of tripped endpoints for logging */
    getTrippedEndpoints() {
        const tripped = [];
        for (const name of this.states.keys()) {
            if (this.isOpen(name))
                tripped.push(name);
        }
        return tripped;
    }
}
//# sourceMappingURL=circuit-breaker.js.map