// ---------------------------------------------------------------------------
// Shared CLI formatting and status utilities
// Used by cli command, delegate command, tools, delegate-control, and relay.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
// ---------------------------------------------------------------------------
// Status derivation
// ---------------------------------------------------------------------------
export function deriveExecutionStatus(meta) {
    if (!meta) {
        return 'unknown';
    }
    if (meta.cancelledAt) {
        return 'cancelled';
    }
    if (meta.exitCode === undefined && !meta.completedAt) {
        return 'running';
    }
    if (meta.exitCode === 0) {
        return 'completed';
    }
    return meta.exitCode === undefined ? 'unknown' : `exit:${meta.exitCode}`;
}
export function deriveDelegateStatus(meta, job) {
    if ((job?.status === 'running' || job?.status === 'queued')
        && job.metadata
        && typeof job.metadata.cancelRequestedAt === 'string') {
        return 'cancelling';
    }
    return job?.status ?? deriveExecutionStatus(meta);
}
// ---------------------------------------------------------------------------
// String formatting
// ---------------------------------------------------------------------------
export function padRight(str, len) {
    return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length);
}
/**
 * Collapse newlines to spaces, trim, then truncate with "...".
 * Used by CLI table output (cli show, delegate show).
 */
export function truncate(text, max) {
    const oneLine = text.replace(/\n/g, ' ').trim();
    if (oneLine.length <= max)
        return oneLine;
    return oneLine.slice(0, max - 3) + '...';
}
/**
 * Truncate without newline collapsing — just cutoff with "...".
 * Used by channel relay notifications.
 */
export function truncateRaw(value, max) {
    if (value.length <= max)
        return value;
    return value.slice(0, max - 3) + '...';
}
/**
 * Truncate with ellipsis indicator for history/resume context.
 * Uses different suffix from other truncate variants.
 */
export function truncateForHistory(s, max) {
    return s.length <= max ? s : s.substring(0, max) + '\u2026[truncated]';
}
/**
 * Extract the best-matching body line for a query, prefixed with its line
 * number (e.g. "L12: matched context..."). Scores lines by query-term
 * coverage so multi-term queries surface the most informative line.
 */
export function extractSnippet(body, query, maxLen = 80, highlight = false) {
    if (!body || !query)
        return null;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0)
        return null;
    const lines = body.split('\n');
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed)
            continue;
        const lower = trimmed.toLowerCase();
        let score = 0;
        for (const term of terms) {
            if (lower.includes(term))
                score++;
        }
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    if (bestIdx === -1)
        return null;
    let raw = lines[bestIdx].trim();
    raw = raw.replace(/^#+\s+/, '');
    raw = raw.replace(/^[-*]\s+/, '');
    if (raw.length > maxLen)
        raw = raw.slice(0, maxLen) + '...';
    if (highlight)
        raw = highlightTerms(raw, terms);
    return `L${bestIdx + 1}: ${raw}`;
}
export function highlightTerms(text, terms) {
    if (!terms.length)
        return text;
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(`(${escaped.join('|')})`, 'gi');
    return text.replace(re, '\x1b[1;33m$1\x1b[0m');
}
// ---------------------------------------------------------------------------
// Execution entry reading
// ---------------------------------------------------------------------------
export function readExecutionEntries(store, execId) {
    try {
        const raw = readFileSync(store.jsonlPathFor(execId), 'utf-8');
        return raw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((entry) => entry !== null);
    }
    catch {
        return [];
    }
}
// ---------------------------------------------------------------------------
// Broker event summarization
// ---------------------------------------------------------------------------
/**
 * CLI-friendly single-line summary of a broker event.
 * Used by `delegate status` and `delegate tail` commands.
 */
export function summarizeBrokerEventCli(event) {
    const payloadSummary = typeof event.payload.summary === 'string'
        ? event.payload.summary
        : typeof event.payload.message === 'string'
            ? event.payload.message
            : null;
    const progress = event.snapshot && typeof event.snapshot === 'object' && event.snapshot !== null
        && 'progress' in event.snapshot && typeof event.snapshot.progress === 'number'
        ? ` progress=${event.snapshot.progress}%`
        : '';
    return `${event.eventId} ${event.type}${event.status ? ` (${event.status})` : ''}${progress}${payloadSummary ? ` ${payloadSummary}` : ''}`;
}
/**
 * Structured summary of a broker event (object return).
 * Used by MCP tools (delegate_status, delegate_tail).
 */
export function summarizeBrokerEventStructured(event) {
    return {
        eventId: event.eventId,
        sequence: event.sequence,
        type: event.type,
        createdAt: event.createdAt,
        status: event.status ?? null,
        summary: typeof event.payload.summary === 'string'
            ? event.payload.summary
            : typeof event.payload.message === 'string'
                ? event.payload.message
                : null,
        snapshot: event.snapshot ?? null,
    };
}
//# sourceMappingURL=cli-format.js.map