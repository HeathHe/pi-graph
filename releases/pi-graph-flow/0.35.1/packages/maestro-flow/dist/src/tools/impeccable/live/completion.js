// Copyright 2024 Paul Bakaus (https://github.com/pbakaus/impeccable)
// Licensed under the Apache License, Version 2.0
// Modifications: Converted to TypeScript, adapted for maestro CLI architecture.
export function completionTypeForAcceptResult(eventType, acceptResult) {
    if (eventType === 'discard')
        return acceptResult?.handled === true ? 'discarded' : 'error';
    if (acceptResult?.handled === true && acceptResult?.carbonize === true)
        return 'agent_done';
    if (acceptResult?.handled === true)
        return 'complete';
    if (acceptResult?.mode === 'error')
        return 'error';
    return 'agent_done';
}
export function completionAckForAcceptResult(eventId, completionType, acceptResult) {
    const ack = { ok: true, type: completionType };
    if (acceptResult?.handled === true && acceptResult?.carbonize === true) {
        ack.final = false;
        ack.requiresComplete = true;
        ack.nextCommand = `live-complete --id ${eventId}`;
        ack.message =
            'Carbonize cleanup must be verified, then the session must be completed explicitly before polling again.';
    }
    return ack;
}
//# sourceMappingURL=completion.js.map