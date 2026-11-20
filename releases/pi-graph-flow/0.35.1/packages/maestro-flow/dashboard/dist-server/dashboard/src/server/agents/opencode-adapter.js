// ---------------------------------------------------------------------------
// OpenCodeAdapter — spawns OpenCode CLI with NDJSON protocol
// ---------------------------------------------------------------------------
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BaseAgentAdapter } from './base-adapter.js';
import { EntryNormalizer } from './entry-normalizer.js';
import { loadEnvFile } from './env-file-loader.js';
import { StreamMonitor, DEFAULT_STREAM_TIMEOUT_MS } from './stream-monitor.js';
import { createStaleHandler } from './stale-handler.js';
import { killProcessTree } from './process-tree-kill.js';
import { cleanSpawnEnv } from './env-cleanup.js';
// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
export class OpenCodeAdapter extends BaseAgentAdapter {
    agentType = 'opencode';
    childProcesses = new Map();
    readlineInterfaces = new Map();
    streamMonitors = new Map();
    stoppedEmitted = new Set();
    // --- Lifecycle hooks -----------------------------------------------------
    async doSpawn(processId, config) {
        const args = ['run', '--format', 'json'];
        // Optional model flag
        if (config.model) {
            args.push('--model', config.model);
        }
        // Prompt is a positional argument (last)
        args.push(config.prompt);
        const envFromFile = config.envFile ? loadEnvFile(config.envFile) : {};
        const envOverrides = { ...envFromFile, ...config.env };
        if (config.apiKey)
            envOverrides.OPENAI_API_KEY = config.apiKey;
        const childEnv = cleanSpawnEnv(envOverrides);
        const child = spawn('opencode', args, {
            cwd: config.workDir,
            env: childEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: true,
            windowsHide: true,
            // POSIX: own process group so killProcessTree can signal the tree.
            detached: process.platform !== 'win32',
        });
        if (!child.stdout || !child.stderr) {
            throw new Error('Failed to spawn OpenCode: stdio streams not available');
        }
        // Heartbeat monitor: detect stale streams and terminate the process tree
        // (shared cascade with claude/gemini/qwen/codex — see stale-handler.ts).
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
            this.parseOpenCodeMessage(line, processId);
        });
        // Stderr => error entries
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString().trim();
            if (text.length > 0) {
                this.emitEntry(processId, EntryNormalizer.error(processId, text, 'stderr'));
            }
        });
        // Process exit handling
        this.setupProcessListeners(child, processId);
        // Store references
        this.childProcesses.set(processId, child);
        this.readlineInterfaces.set(processId, rl);
        return {
            id: processId,
            type: 'opencode',
            status: 'running',
            config,
            startedAt: new Date().toISOString(),
            pid: child.pid,
        };
    }
    async doStop(processId) {
        const child = this.childProcesses.get(processId);
        if (!child) {
            return;
        }
        // Update status to stopping
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'stopping';
            this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopping', 'User requested stop'));
        }
        // Graceful SIGTERM — whole process tree (cmd.exe grandchildren on Windows)
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
        throw new Error('OpenCode does not support interactive messages');
    }
    async doRespondApproval(_decision) {
        // No-op: OpenCode does not have an approval workflow
    }
    // --- NDJSON parsing ------------------------------------------------------
    parseOpenCodeMessage(line, processId) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return;
        }
        let msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch {
            // Non-JSON lines are silently skipped
            return;
        }
        if (!msg || typeof msg !== 'object' || !('type' in msg)) {
            return;
        }
        switch (msg.type) {
            case 'step_start': {
                const reason = msg.step ?? 'Step started';
                this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'running', reason));
                break;
            }
            case 'text': {
                const content = msg.content ?? '';
                if (content.length > 0) {
                    this.emitEntry(processId, EntryNormalizer.assistantMessage(processId, content, false));
                }
                break;
            }
            case 'tool_use': {
                const name = msg.name ?? 'unknown';
                const input = msg.input ?? {};
                this.emitEntry(processId, EntryNormalizer.toolUse(processId, name, input, 'running'));
                break;
            }
            case 'step_finish': {
                if (msg.usage) {
                    this.emitEntry(processId, EntryNormalizer.tokenUsage(processId, msg.usage.input_tokens ?? 0, msg.usage.output_tokens ?? 0));
                }
                break;
            }
            default:
                // Unknown message types are silently ignored
                break;
        }
    }
    // --- Helpers -------------------------------------------------------------
    setupProcessListeners(child, processId) {
        child.on('exit', (code, signal) => {
            const reason = signal
                ? `Terminated by signal: ${signal}`
                : `Exited with code: ${code ?? 'unknown'}`;
            this.emitStopped(processId, reason);
        });
        // Fallback: 'close' covers Windows shell:true trees where 'exit' is missed.
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
    emitStopped(processId, reason) {
        if (this.stoppedEmitted.has(processId))
            return;
        this.stoppedEmitted.add(processId);
        this.emitEntry(processId, EntryNormalizer.statusChange(processId, 'stopped', reason));
        const proc = this.getProcess(processId);
        if (proc) {
            proc.status = 'stopped';
        }
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
    }
}
//# sourceMappingURL=opencode-adapter.js.map