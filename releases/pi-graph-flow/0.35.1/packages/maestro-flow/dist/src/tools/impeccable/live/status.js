// Copyright 2024 Paul Bakaus (https://github.com/pbakaus/impeccable)
// Licensed under the Apache License, Version 2.0
// Modifications: Converted to TypeScript, adapted for maestro CLI architecture.
/**
 * Print durable recovery status for Impeccable live sessions.
 */
import { createLiveSessionStore } from './session-store.js';
import { readLiveServerInfo } from '../paths.js';
// ---------------------------------------------------------------------------
// Server helpers
// ---------------------------------------------------------------------------
function readServerInfo() {
    return readLiveServerInfo(process.cwd())?.info || null;
}
async function fetchServerStatus(info) {
    if (!info)
        return null;
    try {
        const res = await fetch(`http://localhost:${info.port}/status?token=${info.token}`);
        if (!res.ok)
            return null;
        return (await res.json());
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
export async function statusCli() {
    const info = readServerInfo();
    const server = await fetchServerStatus(info);
    const store = createLiveSessionStore({ cwd: process.cwd() });
    const activeSessions = store.listActiveSessions();
    const payload = {
        liveServer: server
            ? {
                status: server.status,
                port: server.port,
                connectedClients: server.connectedClients,
                pendingEvents: server.pendingEvents,
            }
            : null,
        activeSessions: server?.activeSessions || activeSessions,
        recoveryHint: server
            ? 'Run live-poll.mjs to continue pending work, or live-complete.mjs --id <session> after manual cleanup.'
            : 'Start live-server.mjs to requeue pending durable events, then run live-poll.mjs.',
    };
    console.log(JSON.stringify(payload, null, 2));
}
//# sourceMappingURL=status.js.map