/**
 * Timeline Command — Unified project activity timeline (git + sessions).
 *
 *   maestro timeline                          — last 30 days, all sources
 *   maestro timeline --since 7d               — last 7 days
 *   maestro timeline --since HEAD~20          — since 20 commits ago
 *   maestro timeline --scope git              — git events only
 *   maestro timeline --scope session          — session events only
 *   maestro timeline --json                   — JSON output
 *   maestro timeline --output report.json     — write to file
 */
import { resolve, join, relative, dirname } from 'node:path';
import { writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { truncate } from '../utils/cli-format.js';
import { loadWorkspaceConfig, resolveWorkspaceLinks } from '../config/index.js';
// ── Lazy WikiIndexer singleton ─────────────────────────────────────────
let _indexer = null;
async function getIndexer() {
    if (!_indexer) {
        const { WikiIndexer: Cls } = await import('#maestro-dashboard/wiki/wiki-indexer.js');
        const workflowRoot = resolve('.workflow');
        const projectPath = process.cwd();
        const wsConfig = loadWorkspaceConfig(projectPath);
        const resolved = resolveWorkspaceLinks(projectPath, wsConfig);
        const linkedWorkspaces = resolved
            .filter(lw => lw.valid)
            .map(lw => ({ name: lw.name, workflowRoot: lw.workflowRoot, shareTypes: lw.share }));
        _indexer = new Cls({ workflowRoot, linkedWorkspaces, role: 'reader' });
    }
    return _indexer;
}
// ── Date parsing ───────────────────────────────────────────────────────
/**
 * Parse --since value into an ISO date string.
 * Supports: ISO dates, relative (7d, 2w, 3m), HEAD~N, commit hashes.
 */
function parseSince(value, cwd) {
    // Relative duration: 7d, 2w, 3m
    const relMatch = value.match(/^(\d+)([dwm])$/i);
    if (relMatch) {
        const amount = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        const now = new Date();
        if (unit === 'd')
            now.setDate(now.getDate() - amount);
        else if (unit === 'w')
            now.setDate(now.getDate() - amount * 7);
        else if (unit === 'm')
            now.setMonth(now.getMonth() - amount);
        return now.toISOString();
    }
    // HEAD~N: resolve to commit date
    if (value.startsWith('HEAD~') || value.startsWith('head~')) {
        try {
            const date = execSync(`git log -1 --format="%aI" ${value}`, {
                encoding: 'utf-8',
                cwd,
            }).trim();
            if (date)
                return new Date(date).toISOString();
        }
        catch {
            console.error(`E003: Failed to resolve "${value}" via git log`);
            process.exit(1);
        }
    }
    // Commit hash (7-40 hex chars)
    if (/^[0-9a-f]{7,40}$/i.test(value)) {
        try {
            const date = execSync(`git log -1 --format="%aI" ${value}`, {
                encoding: 'utf-8',
                cwd,
            }).trim();
            if (date)
                return new Date(date).toISOString();
        }
        catch {
            console.error(`E003: Failed to resolve commit "${value}" via git log`);
            process.exit(1);
        }
    }
    // ISO date or date string
    const parsed = new Date(value);
    if (!isNaN(parsed.getTime())) {
        return parsed.toISOString();
    }
    console.error(`E003: Unable to parse --since value: "${value}"`);
    process.exit(1);
}
// ── Git event collection ───────────────────────────────────────────────
function collectGitEvents(sinceDate, cwd) {
    try {
        const isoDate = new Date(sinceDate).toISOString();
        const raw = execSync(`git log --since="${isoDate}" --max-count=1000 --format="COMMIT:%H|%aI|%s" --name-only`, { encoding: 'utf-8', cwd });
        const events = [];
        let current = null;
        for (const line of raw.split('\n')) {
            if (line.startsWith('COMMIT:')) {
                if (current)
                    events.push({ type: 'commit', ...current });
                const payload = line.slice(7);
                const parts = payload.split('|');
                if (parts.length < 3)
                    continue;
                current = { hash: parts[0], at: parts[1], message: parts.slice(2).join('|'), files: [] };
            }
            else if (current && line.trim().length > 0) {
                current.files.push(line.trim());
            }
        }
        if (current)
            events.push({ type: 'commit', ...current });
        return events;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('not a git repository') || msg.includes('fatal: bad default revision')) {
            console.error('E003: not a git repository');
            process.exit(1);
        }
        // Empty repo or no commits in range — return empty list
        console.error('W004: git log returned no results — proceeding with empty git history');
        return [];
    }
}
// ── Git summary (insertions/deletions) ─────────────────────────────────
function computeGitSummary(sinceDate, cwd, commitCount, allFiles) {
    let insertions = 0;
    let deletions = 0;
    try {
        const isoDate = new Date(sinceDate).toISOString();
        const raw = execSync(`git log --since="${isoDate}" --numstat --format=""`, { encoding: 'utf-8', cwd }).trim();
        for (const line of raw.split('\n')) {
            const match = line.match(/^(\d+)\t(\d+)\t/);
            if (match) {
                insertions += parseInt(match[1], 10);
                deletions += parseInt(match[2], 10);
            }
        }
    }
    catch {
        // git log may fail on shallow clones — use commit-level data
    }
    return {
        commits: commitCount,
        files_changed: allFiles.size,
        insertions,
        deletions,
    };
}
// ── Session event collection ───────────────────────────────────────────
async function collectSessionEvents(sinceDate) {
    try {
        const indexer = await getIndexer();
        const index = await indexer.get();
        const sinceMs = new Date(sinceDate).getTime();
        const sessionEntries = index.entries.filter((e) => (e.category === 'session' || e.category === 'scratch') &&
            new Date(e.created).getTime() >= sinceMs);
        return sessionEntries.map((e) => ({
            type: 'session',
            at: e.created,
            id: e.id,
            title: e.title,
            summary: e.summary ?? '',
            edited_files: Array.isArray(e.ext?.editedFiles) ? e.ext.editedFiles : [],
            code_paths: Array.isArray(e.ext?.codePaths) ? e.ext.codePaths : [],
            platform: typeof e.ext?.platform === 'string' ? e.ext.platform : undefined,
        }));
    }
    catch {
        console.error('W001: Wiki/session index unavailable — proceeding with git-only data');
        return [];
    }
}
// ── Hot paths computation ──────────────────────────────────────────────
function computeHotPaths(events, topN) {
    const dirCounts = new Map();
    for (const ev of events) {
        const files = ev.type === 'commit' ? ev.files : [...ev.edited_files, ...ev.code_paths];
        for (const f of files) {
            const dir = dirname(f);
            if (dir === '.')
                continue;
            // Use top-level or second-level directory
            const parts = dir.split(/[/\\]/);
            const key = parts.length >= 2 ? `${parts[0]}/${parts[1]}/` : `${parts[0]}/`;
            dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1);
        }
    }
    return Array.from(dirCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, topN)
        .map(([dir, count]) => `${dir} (${count} changes)`);
}
// ── Cold workflow files ────────────────────────────────────────────────
function findColdWorkflowFiles(sinceDate, cwd) {
    const workflowDir = resolve(cwd, '.workflow');
    if (!existsSync(workflowDir))
        return [];
    const sinceMs = new Date(sinceDate).getTime();
    const cold = [];
    function walk(dir) {
        let entries;
        try {
            entries = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of entries) {
            if (name === '.git' || name === 'node_modules')
                continue;
            const fullPath = join(dir, name);
            try {
                const st = statSync(fullPath);
                if (st.isDirectory()) {
                    walk(fullPath);
                }
                else if (st.isFile() && st.mtimeMs < sinceMs) {
                    cold.push({
                        path: relative(cwd, fullPath).replace(/\\/g, '/'),
                        mtime: st.mtime,
                    });
                }
            }
            catch {
                // Permission errors etc — skip
            }
        }
    }
    walk(workflowDir);
    // Sort by oldest first, return top entries
    cold.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());
    return cold.slice(0, 20).map(c => ({ path: c.path, last_modified: c.mtime.toISOString().slice(0, 10) }));
}
// ── Human-readable output ──────────────────────────────────────────────
function formatHumanOutput(output) {
    const lines = [];
    const { window: w, git_summary: gs, session_summary: ss, events, hot_paths, cold_workflow_files } = output;
    lines.push(`--- Timeline: ${w.from.slice(0, 10)} → ${w.to.slice(0, 10)} (${w.days} days) ---`);
    lines.push('');
    lines.push(`Git: ${gs.commits} commits, ${gs.files_changed} files, +${gs.insertions}/-${gs.deletions}`);
    const platformParts = Object.entries(ss.by_platform)
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => `${p}: ${n}`);
    const platformSuffix = platformParts.length > 0 ? ` (${platformParts.join(', ')})` : '';
    lines.push(`Sessions: ${ss.total} total, ${ss.with_edits} with edits${platformSuffix}`);
    if (hot_paths.length > 0) {
        lines.push('');
        lines.push('Hot paths:');
        for (const p of hot_paths) {
            lines.push(`  ${p}`);
        }
    }
    if (cold_workflow_files.length > 0) {
        lines.push('');
        lines.push('Cold .workflow/ files (not modified in window):');
        for (const f of cold_workflow_files) {
            lines.push(`  ${f.path} (last: ${f.last_modified})`);
        }
    }
    if (events.length > 0) {
        lines.push('');
        lines.push('Recent events:');
        for (const ev of events) {
            const date = ev.at.slice(0, 10);
            if (ev.type === 'commit') {
                const shortHash = ev.hash.slice(0, 7);
                const msg = truncate(ev.message, 60);
                lines.push(`  ${date}  [commit]   ${shortHash}  ${msg}`);
            }
            else {
                const plat = ev.platform ? `[${ev.platform}]` : '[session]';
                const shortId = truncate(ev.id, 12);
                const title = truncate(ev.title, 50);
                lines.push(`  ${date}  ${plat.padEnd(10)}  ${shortId}  ${title}`);
            }
        }
    }
    return lines.join('\n');
}
// ── Command registration ───────────────────────────────────────────────
export function registerTimelineCommand(program) {
    program
        .command('timeline')
        .description('Unified project activity timeline — git commits + sessions')
        .option('--since <date>', 'Analysis starting point: ISO date, relative (7d/2w/3m), HEAD~N, or commit hash', '30d')
        .option('--scope <scope>', 'Event source filter: git, session, all', 'all')
        .option('--json', 'Output as JSON')
        .option('--output <path>', 'Write output to file')
        .option('--limit <n>', 'Max events', '500')
        .option('--platform <name>', 'Filter sessions by platform: claude, codex, all', 'all')
        .action(async (opts) => {
        const cwd = process.cwd();
        const scope = opts.scope;
        const limit = parseInt(opts.limit, 10) || 500;
        const platformFilter = opts.platform ?? 'all';
        const now = new Date();
        if (!['git', 'session', 'all'].includes(scope)) {
            console.error(`Error: --scope must be one of git, session, all (got "${scope}")`);
            process.exit(1);
        }
        // Parse --since
        const sinceDate = parseSince(opts.since, cwd);
        const sinceMs = new Date(sinceDate).getTime();
        const days = Math.max(1, Math.round((now.getTime() - sinceMs) / (1000 * 60 * 60 * 24)));
        // Collect events from each source
        const gitEvents = (scope === 'session')
            ? []
            : collectGitEvents(sinceDate, cwd);
        let sessionEvents = (scope === 'git')
            ? []
            : await collectSessionEvents(sinceDate);
        if (platformFilter !== 'all' && sessionEvents.length > 0) {
            sessionEvents = sessionEvents.filter(s => s.platform === platformFilter);
        }
        // Merge and sort
        const allEvents = [...gitEvents, ...sessionEvents]
            .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
            .slice(0, limit);
        // Compute summaries
        const allGitFiles = new Set();
        for (const ev of gitEvents) {
            for (const f of ev.files)
                allGitFiles.add(f);
        }
        const gitSummary = (scope === 'session')
            ? { commits: 0, files_changed: 0, insertions: 0, deletions: 0 }
            : computeGitSummary(sinceDate, cwd, gitEvents.length, allGitFiles);
        const sessionsWithEdits = sessionEvents.filter(s => s.edited_files.length > 0);
        const lastSessionDate = sessionEvents.length > 0
            ? sessionEvents.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0].at
            : null;
        const byPlatform = {};
        for (const s of sessionEvents) {
            const p = s.platform ?? 'unknown';
            byPlatform[p] = (byPlatform[p] ?? 0) + 1;
        }
        const sessionSummary = {
            total: sessionEvents.length,
            with_edits: sessionsWithEdits.length,
            last_session: lastSessionDate,
            by_platform: byPlatform,
        };
        const hotPaths = computeHotPaths(allEvents, 10);
        const coldWorkflowFiles = findColdWorkflowFiles(sinceDate, cwd);
        const output = {
            window: {
                from: sinceDate,
                to: now.toISOString(),
                days,
            },
            git_summary: gitSummary,
            session_summary: sessionSummary,
            events: allEvents,
            hot_paths: hotPaths,
            cold_workflow_files: coldWorkflowFiles,
        };
        // Output
        if (opts.json || opts.output) {
            const jsonStr = JSON.stringify(output, null, 2);
            if (opts.output) {
                const outPath = resolve(opts.output);
                writeFileSync(outPath, jsonStr, 'utf-8');
                console.log(`Timeline written to ${outPath}`);
            }
            if (opts.json) {
                console.log(jsonStr);
            }
        }
        else {
            console.log(formatHumanOutput(output));
        }
    });
}
//# sourceMappingURL=timeline.js.map