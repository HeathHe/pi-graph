// Copyright 2024 Paul Bakaus (https://github.com/pbakaus/impeccable)
// Licensed under the Apache License, Version 2.0
// Modifications: Converted to TypeScript, adapted for maestro CLI architecture.
/**
 * Recover the next agent action from the durable live-session journal.
 */
import { createLiveSessionStore } from './session-store.js';
// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
export async function resumeCli(opts) {
    const store = createLiveSessionStore({ cwd: process.cwd(), sessionId: opts.id });
    const snapshot = opts.id
        ? store.getSnapshot(opts.id)
        : store.listActiveSessions()[0] || null;
    if (!snapshot) {
        console.log(JSON.stringify({ active: false, nextAction: 'No active durable live session found.' }, null, 2));
        return;
    }
    const pending = snapshot.pendingEvent || null;
    const nextAction = pending
        ? `Run live-poll.mjs, handle ${pending.type} ${pending.id}, then acknowledge with live-poll.mjs --reply ${pending.id} done.`
        : snapshot.phase === 'carbonize_required'
            ? `Finish carbonize cleanup${snapshot.sourceFile ? ` in ${snapshot.sourceFile}` : ''}, then run live-complete.mjs --id ${snapshot.id}.`
            : snapshot.phase === 'accept_requested'
                ? `Run live-complete.mjs --id ${snapshot.id} after verifying the accepted variant is written.`
                : `Inspect ${snapshot.id}; no pending agent event is currently queued.`;
    console.log(JSON.stringify({ active: true, snapshot, pendingEvent: pending, nextAction }, null, 2));
}
//# sourceMappingURL=resume.js.map