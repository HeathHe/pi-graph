import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
    spawn: (...args) => spawnMock(...args),
}));
vi.mock('node:fs', () => ({
    existsSync: vi.fn(() => false),
}));
vi.mock('node:module', () => ({
    createRequire: vi.fn(() => {
        const req = () => ({});
        req.resolve = () => '';
        return req;
    }),
}));
vi.mock('./env-file-loader.js', () => ({
    loadEnvFile: vi.fn(() => ({})),
}));
vi.mock('./env-cleanup.js', () => ({
    cleanSpawnEnv: vi.fn((overrides) => ({
        ...process.env,
        ...overrides,
    })),
}));
vi.mock('./process-tree-kill.js', () => ({
    killProcessTree: vi.fn(),
}));
// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { CodexCliAdapter } from './codex-cli-adapter.js';
function createFakeChild() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = {
        writable: true,
        write: vi.fn(),
        end: vi.fn(),
    };
    child.pid = 54321;
    child.killed = false;
    child.kill = vi.fn();
    return child;
}
function baseConfig(overrides = {}) {
    return {
        type: 'codex',
        prompt: 'Test prompt',
        workDir: '/tmp/test',
        ...overrides,
    };
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CodexCliAdapter', () => {
    let adapter;
    let fakeChild;
    beforeEach(() => {
        adapter = new CodexCliAdapter();
        fakeChild = createFakeChild();
        spawnMock.mockReset();
        spawnMock.mockReturnValue(fakeChild);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    // -----------------------------------------------------------------------
    // Spawn basics
    // -----------------------------------------------------------------------
    describe('spawn', () => {
        it('spawns codex with exec --json and pipes prompt via stdin', async () => {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            expect(proc.type).toBe('codex');
            expect(proc.status).toBe('running');
            const stdin = fakeChild.stdin;
            expect(stdin.write).toHaveBeenCalledWith('Test prompt');
            expect(stdin.end).toHaveBeenCalled();
        });
        it('passes --profile when settingsFile is provided', async () => {
            const config = baseConfig({ settingsFile: 'my-profile' });
            await adapter.spawn(config);
            const cliArgs = spawnMock.mock.calls[0][1];
            expect(cliArgs).toContain('--profile');
            expect(cliArgs[cliArgs.indexOf('--profile') + 1]).toBe('my-profile');
        });
        it('maps reasoningEffort max to xhigh', async () => {
            const config = baseConfig({ reasoningEffort: 'max' });
            await adapter.spawn(config);
            const cliArgs = spawnMock.mock.calls[0][1];
            expect(cliArgs).toContain('-c');
            const cIdx = cliArgs.indexOf('-c');
            expect(cliArgs[cIdx + 1]).toBe('model_reasoning_effort="xhigh"');
        });
    });
    // -----------------------------------------------------------------------
    // NDJSON stdout parsing
    // -----------------------------------------------------------------------
    describe('NDJSON stdout parsing', () => {
        async function spawnAndCollect(lines) {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            for (const line of lines) {
                fakeChild.stdout.write(line + '\n');
            }
            await new Promise((r) => setTimeout(r, 20));
            return entries;
        }
        it('parses item.completed with message content', async () => {
            const entries = await spawnAndCollect([
                JSON.stringify({
                    type: 'item.completed',
                    item: { type: 'message', content: [{ type: 'text', text: 'Hello from codex' }] },
                }),
                JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
            ]);
            const msgs = entries.filter((e) => e.type === 'assistant_message');
            expect(msgs.length).toBeGreaterThanOrEqual(1);
            const finalMsg = msgs.find((e) => e.partial === false);
            expect(finalMsg).toBeDefined();
            expect(finalMsg.content).toContain('Hello from codex');
        });
        it('parses turn.completed with token usage', async () => {
            const entries = await spawnAndCollect([
                JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, output_tokens: 80 } }),
            ]);
            const usage = entries.filter((e) => e.type === 'token_usage');
            expect(usage).toHaveLength(1);
            expect(usage[0].inputTokens).toBe(200);
            expect(usage[0].outputTokens).toBe(80);
        });
        it('parses command_execution items', async () => {
            const entries = await spawnAndCollect([
                JSON.stringify({
                    type: 'item.completed',
                    item: {
                        type: 'command_execution',
                        command: 'ls -la',
                        aggregated_output: 'total 8\ndrwxr-xr-x ...',
                        exit_code: 0,
                    },
                }),
            ]);
            const cmds = entries.filter((e) => e.type === 'command_exec');
            expect(cmds).toHaveLength(1);
            expect(cmds[0].command).toBe('ls -la');
        });
        it('parses error messages from stdout', async () => {
            const entries = await spawnAndCollect([
                JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }),
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('Rate limit exceeded');
        });
        it('skips non-JSON lines', async () => {
            const entries = await spawnAndCollect([
                'OpenAI Codex v0.137.0',
                '--------',
                JSON.stringify({ type: 'thread.started' }),
            ]);
            const statusEntries = entries.filter((e) => e.type === 'status_change');
            expect(statusEntries.length).toBeGreaterThanOrEqual(1);
        });
    });
    // -----------------------------------------------------------------------
    // Stderr handling — non-fatal Rust tracing logs
    // -----------------------------------------------------------------------
    describe('stderr: non-fatal Rust tracing logs', () => {
        async function spawnAndCollectStderr(stderrLines) {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            for (const line of stderrLines) {
                fakeChild.stderr.write(line + '\n');
            }
            await new Promise((r) => setTimeout(r, 20));
            return entries;
        }
        it('classifies RMCP transport error as thinking (not error)', async () => {
            const entries = await spawnAndCollectStderr([
                '2026-06-08T06:37:29.317417Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when Client(HttpRequest(HttpRequest("http/request failed: error sending request for url (https://chatgpt.com/backend-api/wham/apps)")))',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking.length).toBeGreaterThanOrEqual(1);
            expect(thinking[0].content).toContain('rmcp::transport::worker');
        });
        it('classifies websocket connection error as thinking (not error)', async () => {
            const entries = await spawnAndCollectStderr([
                '2026-06-08T06:38:02.259971Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: tls handshake eof, url: wss://chatgpt.com/backend-api/codex/responses',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking.length).toBeGreaterThanOrEqual(1);
        });
        it('classifies WARN-level Rust tracing log as thinking', async () => {
            const entries = await spawnAndCollectStderr([
                '2026-06-08T06:37:28.000000Z WARN codex_core::config: deprecated config field detected',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking.length).toBeGreaterThanOrEqual(1);
        });
        it('classifies INFO-level Rust tracing log as thinking', async () => {
            const entries = await spawnAndCollectStderr([
                '2026-06-08T06:37:28.000000Z INFO codex_core::server: listening on port 3000',
            ]);
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(thinking.length).toBeGreaterThanOrEqual(1);
        });
        it('still classifies non-tracing error lines as error', async () => {
            const entries = await spawnAndCollectStderr([
                'Error: OPENAI_API_KEY not set',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            expect(errors).toHaveLength(1);
            expect(errors[0].message).toBe('Error: OPENAI_API_KEY not set');
        });
        it('still classifies fatal non-tracing lines as error', async () => {
            const entries = await spawnAndCollectStderr([
                'fatal: unable to access repository',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            expect(errors).toHaveLength(1);
        });
        it('classifies plain reasoning text as thinking', async () => {
            const entries = await spawnAndCollectStderr([
                'Thinking about the best approach...',
                'Analyzing code structure',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking).toHaveLength(2);
        });
        it('handles multiple RMCP errors in one chunk without false positives', async () => {
            const entries = await spawnAndCollectStderr([
                '2026-06-08T06:37:29.317417Z ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed',
                '2026-06-08T06:38:02.259971Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket',
                'codex session started',
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking).toHaveLength(3);
        });
        it('classifies JSON structured error on stderr as thinking', async () => {
            const entries = await spawnAndCollectStderr([
                JSON.stringify({ type: 'error', message: 'Non-fatal structured warning' }),
            ]);
            const errors = entries.filter((e) => e.type === 'error');
            const thinking = entries.filter((e) => e.type === 'thinking');
            expect(errors).toHaveLength(0);
            expect(thinking.length).toBeGreaterThanOrEqual(1);
        });
    });
    // -----------------------------------------------------------------------
    // Process exit
    // -----------------------------------------------------------------------
    describe('process exit', () => {
        it('emits stopped on process exit', async () => {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            fakeChild.emit('exit', 0, null);
            await new Promise((r) => setTimeout(r, 20));
            const stopped = entries.filter((e) => e.type === 'status_change' && e.status === 'stopped');
            expect(stopped).toHaveLength(1);
        });
        it('emits stopped only once when both exit and close fire', async () => {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            fakeChild.emit('exit', 0, null);
            fakeChild.emit('close', 0, null);
            await new Promise((r) => setTimeout(r, 20));
            const stopped = entries.filter((e) => e.type === 'status_change' && e.status === 'stopped');
            expect(stopped).toHaveLength(1);
        });
        it('includes exit code in stopped reason', async () => {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            fakeChild.emit('exit', 1, null);
            await new Promise((r) => setTimeout(r, 20));
            const stopped = entries.find((e) => e.type === 'status_change' && e.status === 'stopped');
            expect(stopped).toBeDefined();
            expect(stopped.reason).toContain('1');
        });
        it('succeeds despite RMCP errors when codex exits 0', async () => {
            const config = baseConfig();
            const proc = await adapter.spawn(config);
            const entries = [];
            adapter.onEntry(proc.id, (entry) => {
                entries.push(entry);
            });
            // Simulate RMCP error then successful response then exit
            fakeChild.stderr.write('2026-06-08T06:37:29.317417Z ERROR rmcp::transport::worker: worker quit with fatal\n');
            fakeChild.stdout.write(JSON.stringify({
                type: 'item.completed',
                item: { type: 'message', content: [{ type: 'text', text: 'I am Codex' }] },
            }) + '\n');
            fakeChild.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }) + '\n');
            await new Promise((r) => setTimeout(r, 20));
            fakeChild.emit('exit', 0, null);
            await new Promise((r) => setTimeout(r, 20));
            // No error entries from the RMCP warning
            const errors = entries.filter((e) => e.type === 'error');
            expect(errors).toHaveLength(0);
            // Assistant message present
            const msgs = entries.filter((e) => e.type === 'assistant_message');
            expect(msgs.length).toBeGreaterThanOrEqual(1);
            // Process stopped normally
            const stopped = entries.filter((e) => e.type === 'status_change' && e.status === 'stopped');
            expect(stopped).toHaveLength(1);
        });
    });
});
//# sourceMappingURL=codex-cli-adapter.test.js.map