// Copyright 2024 Paul Bakaus (https://github.com/pbakaus/impeccable)
// Licensed under the Apache License, Version 2.0
// Modifications: Converted to TypeScript, adapted for maestro CLI architecture.
/**
 * Canonical durable completion acknowledgement for Impeccable live sessions.
 */
import { createLiveSessionStore } from './session-store.js';
import { readLiveServerInfo } from '../paths.js';
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
export async function completeCli(opts) {
    const store = createLiveSessionStore({ cwd: process.cwd(), sessionId: opts.id });
    const status = opts.discarded === true
        ? 'discarded'
        : opts.error
            ? 'agent_error'
            : 'complete';
    const message = typeof opts.error === 'string' ? opts.error : 'unknown error';
    const serverInfo = readServerInfo();
    const serverResult = serverInfo
        ? await completeThroughServer(serverInfo, {
            id: opts.id,
            status,
            message,
        })
        : null;
    if (serverResult?.ok) {
        const snapshot = store.getSnapshot(opts.id, { includeCompleted: true });
        console.log(JSON.stringify({ ok: true, id: opts.id, phase: snapshot?.phase || status, snapshot }, null, 2));
        return;
    }
    const event = status === 'discarded'
        ? { type: 'discarded', id: opts.id }
        : status === 'agent_error'
            ? { type: 'agent_error', id: opts.id, message }
            : { type: 'complete', id: opts.id };
    const snapshot = store.appendEvent(event);
    console.log(JSON.stringify({ ok: true, id: opts.id, phase: snapshot.phase, snapshot }, null, 2));
}
// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------
function readServerInfo() {
    return readLiveServerInfo(process.cwd())?.info || null;
}
async function completeThroughServer(info, args) {
    const type = args.status === 'discarded'
        ? 'discarded'
        : args.status === 'agent_error'
            ? 'error'
            : 'complete';
    try {
        const res = await fetch(`http://localhost:${info.port}/poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: info.token, id: args.id, type, message: args.message }),
        });
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=complete.js.map