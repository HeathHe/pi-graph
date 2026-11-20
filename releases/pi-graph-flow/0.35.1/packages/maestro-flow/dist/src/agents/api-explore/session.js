import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
function exploreDir(cwd) {
    return join(cwd, '.workflow', 'explore');
}
export function generateSessionId() {
    const now = new Date();
    const ts = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
    ].join('');
    const rand = Math.random().toString(36).slice(2, 6);
    return `exp-${ts}-${rand}`;
}
export function saveSession(session, outputDir) {
    const dir = outputDir ?? exploreDir(session.cwd);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${session.id}.json`);
    writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    return filePath;
}
export function loadSession(cwd, sessionId, outputDir) {
    const dir = outputDir ?? exploreDir(cwd);
    const filePath = join(dir, `${sessionId}.json`);
    if (!existsSync(filePath))
        return null;
    try {
        return JSON.parse(readFileSync(filePath, 'utf-8'));
    }
    catch {
        return null;
    }
}
export function listSessions(cwd, outputDir) {
    const dir = outputDir ?? exploreDir(cwd);
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter(f => f.startsWith('exp-') && f.endsWith('.json'))
        .map(f => {
        try {
            const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
            return { id: raw.id, startedAt: raw.startedAt, prompts: raw.prompts.length, durationMs: raw.durationMs };
        }
        catch {
            return null;
        }
    })
        .filter((s) => s !== null)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
//# sourceMappingURL=session.js.map