/**
 * Maestro Delegate Monitor — PostToolUse Hook (fallback)
 *
 * Checks /tmp/maestro-notify-{session_id}.jsonl for unread delegate
 * completion notifications. When found, injects additionalContext to inform
 * the model that a delegated task has finished.
 *
 * Primary path: MCP channel notification (notifications/claude/channel).
 * This hook is the fallback when channel is not available.
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NOTIFY_PREFIX } from './constants.js';
function readNotifications(sessionId) {
    const path = join(tmpdir(), `${NOTIFY_PREFIX}${sessionId}.jsonl`);
    if (!existsSync(path))
        return [];
    const content = readFileSync(path, 'utf-8').trim();
    if (!content)
        return [];
    return content.split('\n')
        .map(line => { try {
        return JSON.parse(line);
    }
    catch {
        return null;
    } })
        .filter((e) => e !== null);
}
function markRead(sessionId, entries) {
    const path = join(tmpdir(), `${NOTIFY_PREFIX}${sessionId}.jsonl`);
    const marked = entries.map(e => ({ ...e, read: true }));
    writeFileSync(path, marked.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8');
}
export function evaluateDelegateNotifications(data) {
    const sessionId = data.session_id;
    if (!sessionId)
        return null;
    const entries = readNotifications(sessionId);
    const unread = entries.filter(e => !e.read);
    if (unread.length === 0)
        return null;
    markRead(sessionId, entries);
    const lines = unread.map(e => {
        const status = e.exitCode === 0 ? 'done' : `exit:${e.exitCode}`;
        const preview = e.prompt.length > 80 ? e.prompt.slice(0, 77) + '...' : e.prompt;
        return `[DELEGATE ${status}] ${e.execId} ${e.tool}/${e.mode} — "${preview}"`;
    });
    return {
        hookSpecificOutput: {
            hookEventName: data.hook_event_name || 'PostToolUse',
            additionalContext: lines.join('\n'),
        },
    };
}
export function runDelegateMonitor() {
    let input = '';
    const timeout = setTimeout(() => process.exit(0), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (input += chunk));
    process.stdin.on('end', () => {
        clearTimeout(timeout);
        try {
            const data = JSON.parse(input);
            const result = evaluateDelegateNotifications(data);
            if (result) {
                process.stdout.write(JSON.stringify(result));
            }
        }
        catch {
            process.exit(0);
        }
    });
}
//# sourceMappingURL=delegate-monitor.js.map