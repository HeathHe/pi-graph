// ---------------------------------------------------------------------------
// AgyAdapter — spawns the Antigravity (agy) CLI in non-interactive --print mode
//
// agy output strategy (transcript-first):
//   In non-TTY mode (i.e. spawned by Node with piped stdio), agy writes
//   **nothing** to stdout. The full conversation — user input, planner
//   responses, tool calls, tool results — lands in
//   ~/.gemini/antigravity-cli/brain/<conv>/.system_generated/logs/transcript.jsonl
//
//   We locate the conversation for the current workspace via
//   ~/.gemini/antigravity-cli/cache/last_conversations.json[workdir]
//   (agy updates this map every run), then replay transcript entries that
//   landed after our spawn timestamp.
//
//   stdout is still wired up as a fallback in case a future agy build emits
//   text there, but PLANNER_RESPONSE.content from the transcript is the
//   authoritative assistant reply.
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { BaseAgentAdapter } from './base-adapter.js';
import { EntryNormalizer } from './entry-normalizer.js';
import { loadEnvFile } from './env-file-loader.js';
import { StreamMonitor, DEFAULT_STREAM_TIMEOUT_MS } from './stream-monitor.js';
import { createStaleHandler } from './stale-handler.js';
import { killProcessTree } from './process-tree-kill.js';
import { cleanSpawnEnv } from './env-cleanup.js';
// Tool result-bearing entry types (model emits content as the result text).
const TOOL_RESULT_TYPES = new Set([
    'LIST_DIRECTORY',
    'VIEW_FILE',
    'CODE_ACTION',
    'GENERIC',
    'GREP_SEARCH',
    'SEARCH_WEB',
    'RUN_COMMAND',
    'READ_URL_CONTENT',
]);
// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------
const DEFAULT_AGY_BIN_CANDIDATES = () => {
    const candidates = [];
    if (process.platform === 'win32') {
        candidates.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agy', 'bin', 'agy.exe'));
    }
    else {
        candidates.push(join(homedir(), '.local', 'bin', 'agy'));
        candidates.push('/usr/local/bin/agy');
    }
    return candidates;
};
function resolveAgyBinary() {
    for (const p of DEFAULT_AGY_BIN_CANDIDATES()) {
        if (existsSync(p))
            return p;
    }
    // Fall back to PATH resolution via shell.
    return 'agy';
}
const AGY_BRAIN_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'brain');
const AGY_LAST_CONV_FILE = join(homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
/** Case-insensitive path equality on Windows. */
function samePath(a, b) {
    const left = resolve(a);
    const right = resolve(b);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}
// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export class AgyAdapter extends BaseAgentAdapter {
    agentType = 'agy';
    childProcesses = new Map();
    readlineInterfaces = new Map();
    streamMonitors = new Map();
    stoppedEmitted = new Set();
    spawnTimestamps = new Map();
    textBuffers = new Map();
    workDirs = new Map();
    // --- Lifecycle hooks -----------------------------------------------------
    async doSpawn(processId, config) {
        // --print-timeout: convert ms → "<n>s" (agy uses Go duration format)
        // Floor at 60s to give the agent room; ceiling at config.streamTimeoutMs.
        const timeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
        const timeoutSec = Math.max(60, Math.floor(timeoutMs / 1000));
        const args = ['--print-timeout', `${timeoutSec}s`];
        // approvalMode='auto' (write mode) → bypass permission prompts.
        // 'suggest' (analysis mode) keeps defaults.
        if (config.approvalMode === 'auto') {
            args.push('--dangerously-skip-permissions');
        }
        // includeDirs and resume are threaded through config.metadata by the runner
        // (see src/agents/cli-agent-runner.ts:331). Pick them up here.
        const metadata = (config.metadata ?? {});
        // Windows symlink workaround: agy's project discovery creates a symlink
        // at <cwd>/.antigravitycli/<uuid>.json → ~/.gemini/config/projects/<uuid>.json.
        // Without Developer Mode or admin, that symlink call fails and agy
        // silently degrades — no auth, no API call, empty transcript. The home
        // directory already has a working symlink from agy's first interactive
        // run, so launching from there and exposing the real workdir via
        // --add-dir gives agy a valid project context.
        const requestedWorkDir = resolve(config.workDir ?? process.cwd());
        const homeProjectDir = resolve(homedir());
        const launchCwd = process.platform === 'win32' && !samePath(requestedWorkDir, homeProjectDir)
            ? homeProjectDir
            : requestedWorkDir;
        const includeDirs = new Set();
        if (!samePath(launchCwd, requestedWorkDir)) {
            includeDirs.add(requestedWorkDir);
        }
        if (metadata.includeDirs && metadata.includeDirs.length > 0) {
            for (const dir of metadata.includeDirs) {
                includeDirs.add(resolve(dir));
            }
        }
        for (const dir of includeDirs) {
            args.push('--add-dir', dir);
        }
        // Resume: agy supports -c (last) and --conversation <id>.
        if (metadata.agyConversationId) {
            args.push('--conversation', metadata.agyConversationId);
        }
        else if (metadata.agyResumeLast) {
            args.push('-c');
        }
        // Prompt MUST use --prompt (or -p), NOT --print. agy's flag parser
        // registers `--print` as boolean, so `--print "hi"` parses as
        // `--print=true` + positional "hi", which hangs the run. `--prompt`
        // and `-p` take the value as expected.
        args.push('--prompt', config.prompt);
        // Environment
        const envFromFile = config.envFile ? loadEnvFile(config.envFile) : {};
        const envOverrides = { ...envFromFile, ...config.env };
        if (config.apiKey)
            envOverrides.GEMINI_API_KEY = config.apiKey;
        const childEnv = cleanSpawnEnv(envOverrides);
        const bin = resolveAgyBinary();
        const usesPath = bin === 'agy';
        const spawnedAt = Date.now();
        this.spawnTimestamps.set(processId, spawnedAt);
        // last_conversations.json is keyed by the cwd agy was launched with —
        // when we redirect to homedir, look up the conversation under that key.
        this.workDirs.set(processId, launchCwd);
        const child = spawn(bin, args, {
            cwd: launchCwd,
            env: childEnv,
            // stdin must NOT be a pipe — agy --print waits for stdin EOF before
            // processing the prompt argv, so leaving stdin open hangs the process.
            // Using 'ignore' detaches stdin entirely (equivalent to closing it).
            stdio: ['ignore', 'pipe', 'pipe'],
            // Use shell only when falling back to PATH lookup; resolved absolute
            // paths spawn directly so killProcessTree owns the whole tree.
            shell: usesPath,
            windowsHide: true,
            detached: process.platform !== 'win32',
        });
        if (!child.stdout || !child.stderr) {
            throw new Error('Failed to spawn agy: stdio streams not available');
        }
        // Stale-stream monitor — shared cascade with other adapters.
        const monitor = new StreamMonitor(createStaleHandler({
            processId,
            child,
            timeoutMs,
            onStaleDetected: (message) => this.emitEntry(processId, EntryNormalizer.error(processId, message, 'stream_stale')),
            isStopped: () => this.stoppedEmitted.has(processId),
            emitStopped: (reason) => this.emitStopped(processId, reason),
        }), timeoutMs);
        this.streamMonitors.set(processId, monitor);
        // stdout = plain-text assistant reply. We buffer chunks and re-emit each
        // line as a (partial=false) assistant_message so the dashboard / TUI sees
        // the response as it lands. A single combined message is emitted after
        // exit to make the final transcript self-contained.
        this.textBuffers.set(processId, '');
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line) => {
            monitor.heartbeat();
            const trimmed = line.trim();
            if (trimmed.length === 0)
                return;
            const buf = this.textBuffers.get(processId) ?? '';
            this.textBuffers.set(processId, buf.length === 0 ? trimmed : `${buf}\n${trimmed}`);
            this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, trimmed, true));
        });
        // stderr → error entries (skipped for transient progress noise).
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length === 0)
                return;
            // agy prints progress lines like "Thinking..." to stderr — filter them.
            if (/^(thinking|processing|loading|connecting)\b/i.test(text))
                return;
            this.emitEntry(processId, EntryNormalizer.error(processId, text, 'stderr'));
        });
        this.setupProcessListeners(child, processId);
        this.childProcesses.set(processId, child);
        this.readlineInterfaces.set(processId, rl);
        return {
            id: processId,
            type: 'agy',
            status: 'running',
            config,
            startedAt: new Date().toISOString(),
            pid: child.pid,
        };
    }
    async doStop(processId) {
        const child = this.childProcesses.get(processId);
        if (!child)
            return;
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'stopping';
            this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopping', 'User requested stop'));
        }
        killProcessTree(child.pid, 'SIGTERM');
        const killTimer = setTimeout(() => {
            if (!child.killed)
                killProcessTree(child.pid, 'SIGKILL');
        }, 5000);
        child.once('exit', () => clearTimeout(killTimer));
        this.cleanup(processId);
    }
    async doSendMessage(_processId, _content) {
        // agy --print is single-shot; interactive mode would require -i (--prompt-interactive)
        // which is out of scope for the headless delegate path.
        throw new Error('agy does not support interactive messages in --print mode');
    }
    async doRespondApproval(_decision) {
        // Approvals are gated client-side via --dangerously-skip-permissions.
    }
    // --- Transcript enrichment ----------------------------------------------
    /**
     * Locate the conversationId agy used for this workspace on this run.
     *
     * Strategy:
     *  1. Read cache/last_conversations.json — agy writes the
     *     workspace→conversationId map on every run. If the cache mtime is
     *     after our spawn and the workdir key resolves, return that id.
     *  2. Fall back to scanning brain/ directories for a transcript.jsonl
     *     touched after our spawn (legacy heuristic; handles edge cases where
     *     the cache write is delayed).
     */
    resolveConversationId(processId) {
        const spawnedAt = this.spawnTimestamps.get(processId) ?? 0;
        const workdir = this.workDirs.get(processId);
        if (workdir && existsSync(AGY_LAST_CONV_FILE)) {
            try {
                const stat = statSync(AGY_LAST_CONV_FILE);
                // Allow ±1s clock skew between Node's Date.now() and agy's file write.
                if (stat.mtimeMs >= spawnedAt - 1000) {
                    const data = JSON.parse(readFileSync(AGY_LAST_CONV_FILE, 'utf8'));
                    if (data[workdir])
                        return data[workdir];
                }
            }
            catch {
                // fall through to brain scan
            }
        }
        if (!existsSync(AGY_BRAIN_DIR))
            return undefined;
        let latest = null;
        try {
            for (const entry of readdirSync(AGY_BRAIN_DIR, { withFileTypes: true })) {
                if (!entry.isDirectory())
                    continue;
                const transcriptPath = join(AGY_BRAIN_DIR, entry.name, '.system_generated', 'logs', 'transcript.jsonl');
                if (!existsSync(transcriptPath))
                    continue;
                const mtime = statSync(transcriptPath).mtimeMs;
                if (mtime < spawnedAt - 1000)
                    continue;
                if (!latest || mtime > latest.mtime)
                    latest = { id: entry.name, mtime };
            }
        }
        catch {
            return undefined;
        }
        return latest?.id;
    }
    /**
     * After the agy process exits, locate the conversation transcript for our
     * workspace and replay the entries that landed during our turn. The
     * PLANNER_RESPONSE.content carries the model's actual reply text — that's
     * the primary assistant_message source since stdout is empty in non-TTY
     * mode. Tool calls and intermediate results become tool_use entries.
     */
    enrichFromTranscript(processId) {
        const spawnedAt = this.spawnTimestamps.get(processId) ?? 0;
        const conversationId = this.resolveConversationId(processId);
        if (!conversationId)
            return;
        const transcriptPath = join(AGY_BRAIN_DIR, conversationId, '.system_generated', 'logs', 'transcript.jsonl');
        if (!existsSync(transcriptPath))
            return;
        let content;
        try {
            content = readFileSync(transcriptPath, 'utf8');
        }
        catch {
            return;
        }
        // Replay entries written after our spawn (with 1s skew tolerance).
        const cutoff = new Date(spawnedAt - 1000).toISOString();
        const ourEntries = [];
        for (const line of content.split('\n')) {
            if (line.trim().length === 0)
                continue;
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (entry.created_at && entry.created_at >= cutoff) {
                ourEntries.push(entry);
            }
        }
        let emittedAssistant = false;
        for (const entry of ourEntries) {
            if (entry.source === 'MODEL' && entry.type === 'PLANNER_RESPONSE') {
                if (entry.thinking && entry.thinking.trim().length > 0) {
                    this.emitEntry(processId, EntryNormalizer.thinking(processId, entry.thinking.trim()));
                }
                if (entry.content && entry.content.trim().length > 0) {
                    this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, entry.content.trim(), false));
                    emittedAssistant = true;
                }
                if (entry.tool_calls && entry.tool_calls.length > 0) {
                    for (const call of entry.tool_calls) {
                        const name = call.name ?? 'unknown';
                        const input = call.args ?? {};
                        this.emitEntry(processId, EntryNormalizer.toolUse(processId, name, input, 'running'));
                    }
                }
                continue;
            }
            if (entry.source === 'MODEL' && TOOL_RESULT_TYPES.has(entry.type)) {
                const result = entry.content ?? '';
                const status = entry.status === 'ERROR' ? 'failed' : 'completed';
                this.emitEntry(processId, EntryNormalizer.toolUse(processId, entry.type.toLowerCase(), {}, status, result.slice(0, 4000)));
                continue;
            }
            if (entry.source === 'SYSTEM' && entry.type === 'ERROR_MESSAGE') {
                const msg = entry.error ?? entry.content ?? 'Unknown agy error';
                this.emitEntry(processId, EntryNormalizer.error(processId, msg, 'agy_transcript_error'));
            }
        }
        // Fallback: if the transcript produced no PLANNER_RESPONSE.content but
        // stdout buffered something (future TTY support), surface that.
        if (!emittedAssistant) {
            const buffered = this.textBuffers.get(processId);
            if (buffered && buffered.trim().length > 0) {
                this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, buffered.trim(), false));
            }
        }
        // Record conversationId so a follow-up `maestro delegate --resume`
        // can pass it via --conversation.
        this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'running', `agy.conversationId=${conversationId}`));
    }
    // --- Helpers -------------------------------------------------------------
    setupProcessListeners(child, processId) {
        child.on('exit', (code, signal) => {
            const reason = signal ? `Terminated by signal: ${signal}` : `Exited with code: ${code ?? 'unknown'}`;
            this.emitStopped(processId, reason);
        });
        child.on('close', (code, signal) => {
            const reason = signal ? `Terminated by signal: ${signal}` : `Exited with code: ${code ?? 'unknown'}`;
            this.emitStopped(processId, reason);
        });
        child.on('error', (err) => {
            this.emitEntry(processId, EntryNormalizer.error(processId, err.message, 'spawn_error'));
            const proc = this.getProcess(processId);
            if (proc)
                proc.status = 'error';
        });
    }
    emitStopped(processId, reason) {
        if (this.stoppedEmitted.has(processId))
            return;
        this.stoppedEmitted.add(processId);
        // Enrich with transcript-derived entries BEFORE emitting the terminal
        // status change so consumers see tool history before stop.
        try {
            this.enrichFromTranscript(processId);
        }
        catch {
            // enrichment is best-effort and must never block the stop signal
        }
        this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopped', reason));
        const proc = this.getProcess(processId);
        if (proc)
            proc.status = 'stopped';
        this.cleanup(processId);
        this.removeProcess(processId);
    }
    cleanup(processId) {
        const rl = this.readlineInterfaces.get(processId);
        if (rl) {
            rl.close();
            this.readlineInterfaces.delete(processId);
        }
        const monitor = this.streamMonitors.get(processId);
        if (monitor) {
            monitor.dispose();
            this.streamMonitors.delete(processId);
        }
        this.childProcesses.delete(processId);
        this.spawnTimestamps.delete(processId);
        this.textBuffers.delete(processId);
        this.workDirs.delete(processId);
    }
}
//# sourceMappingURL=agy-adapter.js.map