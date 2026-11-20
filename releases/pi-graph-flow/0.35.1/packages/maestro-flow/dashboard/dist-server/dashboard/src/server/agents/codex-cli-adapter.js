// ---------------------------------------------------------------------------
// CodexCliAdapter -- spawns OpenAI Codex CLI with NDJSON protocol
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { BaseAgentAdapter } from './base-adapter.js';
import { EntryNormalizer } from './entry-normalizer.js';
import { loadEnvFile } from './env-file-loader.js';
import { StreamMonitor, DEFAULT_STREAM_TIMEOUT_MS } from './stream-monitor.js';
import { createStaleHandler } from './stale-handler.js';
import { killProcessTree } from './process-tree-kill.js';
import { cleanSpawnEnv } from './env-cleanup.js';
// ---------------------------------------------------------------------------
// Stderr error pattern
// ---------------------------------------------------------------------------
const STDERR_ERROR_RE = /\b(error|fatal)\b/i;
// Rust tracing log format: "2026-06-08T06:37:29.317417Z ERROR rmcp::transport::..."
// These are diagnostic logs from the codex binary, not process-level failures.
// RMCP/MCP bootstrap errors (wham/apps, websocket) are non-fatal — codex
// falls back to alternative transports and continues normal operation.
const CODEX_NONFATAL_STDERR_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+\S+::/;
// ---------------------------------------------------------------------------
// Native binary resolution — bypass shell/shim layers on Windows
// ---------------------------------------------------------------------------
/**
 * Resolve the native codex binary path by replicating the logic from
 * `@openai/codex/bin/codex.js`. On Windows, `shell: true` creates a
 * fragile process chain (cmd.exe → codex.cmd → node codex.js → codex.exe)
 * where intermediate processes can exit before the native binary finishes,
 * breaking the stdout pipe. Resolving the native binary directly and spawning
 * without `shell: true` eliminates this race condition.
 *
 * Returns the absolute path to the native binary, or null if not found
 * (in which case the adapter falls back to shell-based spawn).
 */
function resolveCodexNativeBinary() {
    const isWin = process.platform === 'win32';
    const binaryName = isWin ? 'codex.exe' : 'codex';
    const targetTriples = {
        win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
        linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
        darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
    };
    const triple = targetTriples[process.platform]?.[process.arch];
    if (!triple)
        return null;
    const platformPackages = {
        'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
        'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
        'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
        'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
        'x86_64-apple-darwin': '@openai/codex-darwin-x64',
        'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
    };
    const platformPkg = platformPackages[triple];
    if (!platformPkg)
        return null;
    // Strategy 1: resolve via npm global install (most common)
    try {
        const npmGlobal = isWin
            ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex')
            : '';
        // Use createRequire from the codex package location
        const codexPkgPaths = [
            npmGlobal ? join(npmGlobal, 'package.json') : '',
            // Also try resolving from cwd
        ].filter(Boolean);
        for (const basePath of codexPkgPaths) {
            try {
                const req = createRequire(basePath);
                const pkgJsonPath = req.resolve(`${platformPkg}/package.json`);
                const vendorRoot = join(dirname(pkgJsonPath), 'vendor');
                const candidate = join(vendorRoot, triple, 'codex', binaryName);
                if (existsSync(candidate))
                    return candidate;
            }
            catch { /* continue */ }
        }
    }
    catch { /* continue */ }
    // Strategy 2: look for local vendor directory relative to codex shim
    try {
        const shimPath = isWin
            ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'vendor')
            : '';
        if (shimPath) {
            const candidate = join(shimPath, triple, 'codex', binaryName);
            if (existsSync(candidate))
                return candidate;
        }
    }
    catch { /* continue */ }
    return null;
}
// Cache the resolved binary path (or null) to avoid repeated filesystem lookups
let _cachedCodexBinary;
function getCodexBinary() {
    if (_cachedCodexBinary === undefined) {
        _cachedCodexBinary = resolveCodexNativeBinary();
    }
    return _cachedCodexBinary;
}
// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export class CodexCliAdapter extends BaseAgentAdapter {
    agentType = 'codex';
    childProcesses = new Map();
    readlineInterfaces = new Map();
    streamMonitors = new Map();
    stoppedEmitted = new Set();
    /** Accumulates assistant message text within a turn; flushed on turn.completed */
    pendingMessages = new Map();
    // --- Lifecycle hooks -----------------------------------------------------
    async doSpawn(processId, config) {
        const args = [
            'exec',
            '--dangerously-bypass-approvals-and-sandbox',
            '--json',
            '--skip-git-repo-check',
            '-',
        ];
        // Profile from config.toml
        if (config.settingsFile) {
            args.push('--profile', config.settingsFile);
        }
        // Reasoning effort → Codex config override (top-level model_reasoning_effort key)
        // Codex supports: low, medium, high, xhigh; map 'max' → 'xhigh'
        if (config.reasoningEffort) {
            const effort = config.reasoningEffort === 'max' ? 'xhigh' : config.reasoningEffort;
            args.push('-c', `model_reasoning_effort="${effort}"`);
        }
        const envFromFile = config.envFile ? loadEnvFile(config.envFile) : {};
        const envOverrides = { ...envFromFile, ...config.env };
        if (config.apiKey)
            envOverrides.OPENAI_API_KEY = config.apiKey;
        const childEnv = cleanSpawnEnv(envOverrides);
        // Prefer the resolved native binary to avoid the fragile shell process
        // chain on Windows (cmd.exe → codex.cmd → node codex.js → codex.exe).
        // When the native binary is found, spawn directly without shell: true.
        const nativeBinary = getCodexBinary();
        const child = nativeBinary
            ? spawn(nativeBinary, args, {
                cwd: config.workDir,
                env: childEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                // POSIX: own process group so killProcessTree can signal the tree.
                detached: process.platform !== 'win32',
            })
            : spawn('codex', args, {
                cwd: config.workDir,
                env: childEnv,
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: true,
                windowsHide: true,
                detached: process.platform !== 'win32',
            });
        if (!child.stdout || !child.stdin || !child.stderr) {
            throw new Error('Failed to spawn Codex CLI: stdio streams not available');
        }
        // Pipe prompt to stdin then close it
        child.stdin.write(config.prompt);
        child.stdin.end();
        // Heartbeat monitor: detect stale streams and terminate the process tree
        // (shared cascade with claude/gemini/qwen/opencode — see stale-handler.ts).
        const staleTimeoutMs = config.streamTimeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
        const monitor = new StreamMonitor(createStaleHandler({
            processId,
            child,
            timeoutMs: staleTimeoutMs,
            onStaleDetected: (message) => this.emitEntry(processId, EntryNormalizer.error(processId, message, 'stream_stale')),
            isStopped: () => this.stoppedEmitted.has(processId),
            emitStopped: (reason) => this.emitStopped(processId, reason),
        }), staleTimeoutMs);
        this.streamMonitors.set(processId, monitor);
        // Line-by-line parsing of NDJSON stdout
        const rl = createInterface({ input: child.stdout });
        rl.on('line', (line) => {
            monitor.heartbeat();
            this.parseCodexMessage(line, processId);
        });
        // Last-resort fallback: if stdout closes but neither 'exit' nor 'close'
        // fire on the child (Windows shell: true + process tree edge case),
        // emit stopped after a short delay to let the primary handlers run first.
        rl.on('close', () => {
            setTimeout(() => {
                this.emitStopped(processId, 'stdout closed (readline fallback)');
            }, 500);
        });
        // Stderr handling: Codex sends warnings, reasoning, and progress to stderr.
        // Try JSON parse first to detect structured messages (warnings/errors).
        // Stderr activity proves the process is alive (e.g. waiting for MCP tool
        // response), so reset the stale-stream heartbeat to avoid false timeouts.
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length === 0)
                return;
            monitor.heartbeat();
            for (const line of text.split('\n')) {
                const trimmed = line.trim();
                if (trimmed.length === 0)
                    continue;
                // Try to parse as JSON — Codex emits structured warnings/errors to stderr
                try {
                    const json = JSON.parse(trimmed);
                    if (json && typeof json === 'object' && json.type === 'error') {
                        // Codex structured warning/error — emit as thinking (non-fatal info)
                        this.emitEntry(processId, EntryNormalizer.thinking(processId, json.message ?? trimmed));
                        continue;
                    }
                }
                catch {
                    // Not JSON — fall through to text classification
                }
                if (CODEX_NONFATAL_STDERR_RE.test(trimmed)) {
                    this.emitEntry(processId, EntryNormalizer.thinking(processId, trimmed));
                }
                else if (STDERR_ERROR_RE.test(trimmed)) {
                    this.emitEntry(processId, EntryNormalizer.error(processId, trimmed, 'stderr'));
                }
                else {
                    // Codex emits reasoning/progress text to stderr; treat as thinking, not output
                    this.emitEntry(processId, EntryNormalizer.thinking(processId, trimmed));
                }
            }
        });
        // Process exit handling
        this.setupProcessListeners(child, processId);
        // Store references
        this.childProcesses.set(processId, child);
        this.readlineInterfaces.set(processId, rl);
        return {
            id: processId,
            type: 'codex',
            status: 'running',
            config,
            startedAt: new Date().toISOString(),
            pid: child.pid,
            interactive: false,
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
        // Graceful SIGTERM — whole process tree (cmd.exe/codex.cmd grandchildren)
        killProcessTree(child.pid, 'SIGTERM');
        // SIGKILL fallback after 5 seconds
        const killTimer = setTimeout(() => {
            if (!child.killed) {
                killProcessTree(child.pid, 'SIGKILL');
            }
        }, 5000);
        child.once('exit', () => {
            clearTimeout(killTimer);
        });
        this.cleanup(processId);
    }
    async doSendMessage(_processId, _content) {
        // Codex exec uses single-prompt mode via stdin (already closed after spawn).
        // Interactive messaging is not supported.
        throw new Error('CodexCliAdapter does not support interactive messaging');
    }
    async doRespondApproval(_decision) {
        // Codex --full-auto mode does not request approvals; no-op.
    }
    // --- NDJSON parsing ------------------------------------------------------
    parseCodexMessage(line, processId) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch {
            // Non-JSON lines silently skipped
            return;
        }
        if (!msg || typeof msg !== 'object' || !('type' in msg))
            return;
        switch (msg.type) {
            case 'thread.started': {
                this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'running', 'Codex session started'));
                break;
            }
            case 'item.completed': {
                const item = msg.item;
                if (item) {
                    this.classifyItem(item, processId);
                }
                break;
            }
            case 'turn.completed': {
                // Flush accumulated assistant messages as final output
                this.flushPendingMessages(processId);
                const usage = msg.usage;
                if (usage) {
                    this.emitEntry(processId, EntryNormalizer.tokenUsage(processId, usage.input_tokens ?? 0, usage.output_tokens ?? 0));
                }
                break;
            }
            case 'error': {
                const errorMsg = msg.message ?? 'Unknown codex error';
                this.emitEntry(processId, EntryNormalizer.error(processId, errorMsg, 'codex_error'));
                break;
            }
            case 'turn.failed': {
                const failedMsg = msg.error?.message ?? 'Turn failed';
                this.emitEntry(processId, EntryNormalizer.error(processId, failedMsg, 'turn_failed'));
                break;
            }
            // turn.started and unknown types are silently skipped
            default:
                break;
        }
    }
    // --- Item classification -------------------------------------------------
    classifyItem(item, processId) {
        const itemType = item.type ?? '';
        const itemName = (item.name ?? '').toLowerCase();
        // Reasoning / thinking content — route to thinking, not assistant_message.
        // Codex newer builds may surface model reasoning as items; without this
        // branch, reasoning text would pollute the final assistant reply extraction.
        if (itemType === 'reasoning' || itemType === 'agent_reasoning') {
            const text = this.extractItemText(item);
            if (text.length > 0) {
                this.emitEntry(processId, EntryNormalizer.thinking(processId, text));
            }
            return;
        }
        // Codex shell tool: explicit `command_execution` item shape
        // (id, command, aggregated_output, exit_code, status). Emit as command_exec
        // boundary so extractLastReply can split segments correctly.
        if (itemType === 'command_execution') {
            const command = item.command ?? item.name ?? 'shell';
            this.emitEntry(processId, EntryNormalizer.commandExec(processId, command, typeof item.exit_code === 'number' ? item.exit_code : undefined, item.aggregated_output ?? item.output ?? ''));
            return;
        }
        // Codex MCP tool call: explicit `mcp_tool_call` item shape
        // (server, tool, arguments, result, error, status). Emit as tool_use
        // boundary so extractLastReply can split segments correctly.
        if (itemType === 'mcp_tool_call') {
            const name = `${item.server ?? 'mcp'}/${item.tool ?? itemName ?? '?'}`;
            const input = this.parseArguments(item.arguments);
            const status = this.codexStatusToToolStatus(item);
            const resultText = item.error
                ? String(item.error)
                : item.result === undefined
                    ? ''
                    : typeof item.result === 'string'
                        ? item.result
                        : JSON.stringify(item.result);
            this.emitEntry(processId, EntryNormalizer.toolUse(processId, name, input, status, resultText));
            return;
        }
        // Function call that looks like a command execution
        if (itemType === 'function_call_output' ||
            (itemType === 'function_call' && this.isCommandCall(itemName)) ||
            (typeof item.output === 'string' && itemType !== 'message')) {
            const command = item.name ?? item.arguments ?? 'codex_exec';
            const output = item.output ?? '';
            this.emitEntry(processId, EntryNormalizer.commandExec(processId, command, undefined, output));
            return;
        }
        // Function call that looks like a file operation
        if (itemType === 'function_call' && this.isFileCall(itemName)) {
            const filePath = item.filename ?? item.path ?? itemName;
            const action = this.inferFileAction(itemName);
            this.emitEntry(processId, EntryNormalizer.fileChange(processId, filePath, action, item.diff));
            return;
        }
        // Safety net: any item whose type smells like a tool/shell call but isn't
        // handled above (e.g. future codex types like `web_search_call`,
        // `local_shell_call`, `custom_tool_call`, `*_output`). Emit as boundary
        // tool_use to prevent JSON.stringify pollution of assistant_message.
        if (this.isToolLikeType(itemType)) {
            const name = item.name ?? item.tool ?? itemType;
            const output = typeof item.output === 'string'
                ? item.output
                : typeof item.aggregated_output === 'string'
                    ? item.aggregated_output
                    : item.result !== undefined
                        ? typeof item.result === 'string'
                            ? item.result
                            : JSON.stringify(item.result)
                        : '';
            const status = this.codexStatusToToolStatus(item);
            this.emitEntry(processId, EntryNormalizer.toolUse(processId, name, this.parseArguments(item.arguments), status, output));
            return;
        }
        // Default: treat as assistant message — accumulate within turn,
        // emit as partial now (for streaming display) and flush final on turn.completed
        const text = this.extractItemText(item);
        if (text.length > 0) {
            const pending = this.pendingMessages.get(processId);
            if (pending) {
                pending.push(text);
            }
            else {
                this.pendingMessages.set(processId, [text]);
            }
            this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, text, true));
        }
    }
    /** Map codex item status/error fields to ToolUseEntry status. */
    codexStatusToToolStatus(item) {
        if (item.error)
            return 'failed';
        switch (item.status) {
            case 'error':
            case 'failed':
                return 'failed';
            case 'pending':
            case 'queued':
                return 'pending';
            case 'running':
            case 'in_progress':
                return 'running';
            case 'success':
            case 'completed':
            case 'done':
            default:
                return 'completed';
        }
    }
    /** Parse codex function/tool `arguments` (JSON string) into an object; tolerate non-JSON. */
    parseArguments(raw) {
        if (raw === undefined || raw === null)
            return {};
        if (typeof raw === 'object')
            return raw;
        if (typeof raw === 'string') {
            const trimmed = raw.trim();
            if (!trimmed)
                return {};
            try {
                const parsed = JSON.parse(trimmed);
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    return parsed;
                }
                return { value: parsed };
            }
            catch {
                return { raw };
            }
        }
        return { value: raw };
    }
    /** Heuristic: does this item.type look like a tool/shell call we should treat as a boundary? */
    isToolLikeType(type) {
        if (!type)
            return false;
        return (type.endsWith('_call') ||
            type.endsWith('_call_output') ||
            type.endsWith('_call_end') ||
            type.endsWith('_execution') ||
            type.endsWith('_output') ||
            /tool|shell|exec|search|patch|file_change/.test(type));
    }
    isCommandCall(name) {
        return /exec|shell|command|run|bash/.test(name);
    }
    isFileCall(name) {
        return /file|write|create|patch|edit|apply|read/.test(name);
    }
    inferFileAction(name) {
        if (/create|new/.test(name))
            return 'create';
        if (/delete|remove/.test(name))
            return 'delete';
        return 'modify';
    }
    /** Flush accumulated partial messages as a single final assistant_message. */
    flushPendingMessages(processId) {
        const pending = this.pendingMessages.get(processId);
        if (!pending || pending.length === 0)
            return;
        this.pendingMessages.delete(processId);
        const finalText = pending.join('\n\n');
        this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, finalText, false));
    }
    extractItemText(item) {
        // Try content array first
        if (Array.isArray(item.content)) {
            const parts = item.content
                .filter((c) => typeof c.text === 'string')
                .map((c) => c.text);
            if (parts.length > 0)
                return parts.join('');
        }
        // Try direct text field
        if (typeof item.text === 'string')
            return item.text;
        // Try output field
        if (typeof item.output === 'string')
            return item.output;
        // Fallback: stringify the item (skip empty objects)
        const json = JSON.stringify(item);
        return json === '{}' ? '' : json;
    }
    // --- Process lifecycle helpers -------------------------------------------
    emitStopped(processId, reason) {
        if (this.stoppedEmitted.has(processId))
            return;
        this.stoppedEmitted.add(processId);
        // Flush any pending messages that weren't flushed by turn.completed
        this.flushPendingMessages(processId);
        this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopped', reason));
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'stopped';
        }
        this.cleanup(processId);
        this.removeProcess(processId);
    }
    setupProcessListeners(child, processId) {
        child.on('exit', (code, signal) => {
            const reason = signal
                ? `Terminated by signal: ${signal}`
                : `Exited with code: ${code ?? 'unknown'}`;
            this.emitStopped(processId, reason);
        });
        // Fallback: 'close' fires after exit + stdio close — covers edge cases
        // where 'exit' is missed on Windows process trees (shell: true).
        child.on('close', (code, signal) => {
            const reason = signal
                ? `Terminated by signal: ${signal}`
                : `Exited with code: ${code ?? 'unknown'}`;
            this.emitStopped(processId, reason);
        });
        child.on('error', (err) => {
            this.emitEntry(processId, EntryNormalizer.error(processId, err.message, 'spawn_error'));
            const proc = this.getProcess(processId);
            if (proc) {
                proc.status = 'error';
            }
        });
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
        this.pendingMessages.delete(processId);
        // Note: stoppedEmitted is intentionally NOT cleared here — it must persist
        // to guard against the readline close fallback timer firing after cleanup.
    }
}
//# sourceMappingURL=codex-cli-adapter.js.map