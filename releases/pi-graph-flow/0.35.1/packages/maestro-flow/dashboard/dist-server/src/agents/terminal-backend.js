// ---------------------------------------------------------------------------
// Terminal Backend — multiplexer abstraction for tmux and wezterm IPC
// ---------------------------------------------------------------------------
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);
/** Typed wrapper ensuring string stdout/stderr (encoding: utf-8). */
async function execFileAsync(cmd, args, opts) {
    const result = await execFileP(cmd, args, opts);
    return {
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
    };
}
// ---------------------------------------------------------------------------
// Cross-platform subprocess options
// ---------------------------------------------------------------------------
/** Common child_process options with windowsHide:true for all calls. */
export function subprocessOpts(cwd) {
    return {
        encoding: 'utf-8',
        timeout: 5000,
        cwd,
        windowsHide: true,
    };
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
// ---------------------------------------------------------------------------
// TmuxBackend
// ---------------------------------------------------------------------------
export class TmuxBackend {
    type = 'tmux';
    enterDelay;
    constructor(options) {
        this.enterDelay = options?.enterDelayMs
            ?? parseInt(process.env.MAESTRO_TMUX_ENTER_DELAY ?? '500', 10);
    }
    async createPane(options) {
        const { cwd, cmd, direction = 'right', parentPaneId } = options;
        const dirFlag = direction === 'right' ? '-h' : '-v';
        let paneId;
        if (parentPaneId) {
            // Split from existing pane
            const { stdout } = await execFileAsync('tmux', [
                'split-window', dirFlag, '-t', parentPaneId,
                '-P', '-F', '#{pane_id}',
            ], subprocessOpts());
            paneId = stdout.trim();
        }
        else {
            // Create new detached session with a unique name
            const sessionName = `maestro-${Date.now()}-${randomBytes(2).toString('hex')}`;
            await execFileAsync('tmux', [
                'new-session', '-d', '-s', sessionName, '-c', cwd,
            ], subprocessOpts());
            const { stdout } = await execFileAsync('tmux', [
                'list-panes', '-t', sessionName, '-F', '#{pane_id}',
            ], subprocessOpts());
            paneId = stdout.trim().split('\n')[0];
        }
        // Respawn with command if provided
        if (cmd) {
            await execFileAsync('tmux', [
                'respawn-pane', '-k', '-t', paneId, '-c', cwd,
                `bash -l -i -c "${cmd}"`,
            ], subprocessOpts());
        }
        return paneId;
    }
    async sendText(paneId, text) {
        const sanitized = text.replace(/\r/g, '').trim();
        if (!sanitized)
            return;
        // Unique buffer name: pid + timestamp + random (from Bridge pattern)
        const bufName = `maestro-tb-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`;
        try {
            // Exit copy mode if active
            try {
                const { stdout } = await execFileAsync('tmux', [
                    'display-message', '-p', '-t', paneId, '#{pane_in_mode}',
                ], subprocessOpts());
                if (stdout.trim() !== '0') {
                    await execFileAsync('tmux', [
                        'send-keys', '-t', paneId, '-X', 'cancel',
                    ], subprocessOpts());
                }
            }
            catch { /* pane might not be in copy mode */ }
            // Load text into named buffer via stdin
            await execFileAsync('tmux', [
                'load-buffer', '-b', bufName, '-',
            ], { ...subprocessOpts(), input: sanitized });
            // Paste with bracketed paste mode
            await execFileAsync('tmux', [
                'paste-buffer', '-p', '-t', paneId, '-b', bufName,
            ], subprocessOpts());
            // Wait for CLI to process input
            await sleep(this.enterDelay);
            // Send Enter
            await execFileAsync('tmux', [
                'send-keys', '-t', paneId, 'Enter',
            ], subprocessOpts());
        }
        finally {
            // Always clean up buffer
            try {
                await execFileAsync('tmux', [
                    'delete-buffer', '-b', bufName,
                ], subprocessOpts());
            }
            catch { /* buffer may not exist */ }
        }
    }
    async isAlive(paneId) {
        try {
            const { stdout } = await execFileAsync('tmux', [
                'display-message', '-p', '-t', paneId, '#{pane_dead}',
            ], subprocessOpts());
            return stdout.trim() === '0';
        }
        catch {
            return false;
        }
    }
    async getText(paneId, lines = 50) {
        const { stdout } = await execFileAsync('tmux', [
            'capture-pane', '-t', paneId, '-p', '-S', `-${lines}`,
        ], subprocessOpts());
        // Strip ANSI escape sequences
        return stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    }
    async killPane(paneId) {
        try {
            await execFileAsync('tmux', [
                'kill-pane', '-t', paneId,
            ], subprocessOpts());
        }
        catch { /* pane already dead */ }
    }
}
// ---------------------------------------------------------------------------
// WeztermBackend
// ---------------------------------------------------------------------------
export class WeztermBackend {
    type = 'wezterm';
    enterDelay;
    weztermBin;
    constructor(options) {
        this.enterDelay = options?.enterDelayMs
            ?? parseInt(process.env.MAESTRO_WEZTERM_ENTER_DELAY
                ?? (process.platform === 'win32' ? '50' : '10'), 10);
        this.weztermBin = options?.weztermBin
            ?? process.env.WEZTERM_BIN ?? 'wezterm';
    }
    async createPane(options) {
        const { cwd, cmd, direction = 'right', percent = 50, parentPaneId } = options;
        const args = ['cli', 'split-pane'];
        if (direction === 'right')
            args.push('--right');
        else
            args.push('--bottom');
        args.push('--percent', String(percent));
        if (parentPaneId) {
            args.push('--pane-id', parentPaneId);
        }
        args.push('--cwd', cwd);
        if (cmd) {
            args.push('--', cmd);
        }
        const { stdout } = await execFileAsync(this.weztermBin, args, subprocessOpts());
        return stdout.trim(); // pane ID (numeric string)
    }
    async sendText(paneId, text) {
        const sanitized = text.replace(/\r/g, '').trim();
        if (!sanitized)
            return;
        const isMultiLine = sanitized.includes('\n');
        if (!isMultiLine && sanitized.length <= 200) {
            // Short single-line: argv, --no-paste
            await execFileAsync(this.weztermBin, [
                'cli', 'send-text', '--pane-id', paneId, '--no-paste', sanitized,
            ], subprocessOpts());
        }
        else if (!isMultiLine) {
            // Long single-line: stdin, --no-paste
            const opts = { ...subprocessOpts(), input: sanitized };
            await execFileAsync(this.weztermBin, [
                'cli', 'send-text', '--pane-id', paneId, '--no-paste',
            ], opts);
        }
        else {
            // Multi-line: stdin, paste mode (no --no-paste)
            const opts = { ...subprocessOpts(), input: sanitized };
            await execFileAsync(this.weztermBin, [
                'cli', 'send-text', '--pane-id', paneId,
            ], opts);
        }
        // Enter key with delay
        await sleep(this.enterDelay);
        await this.sendEnter(paneId);
    }
    /**
     * 3-level Enter key fallback:
     * 1. wezterm cli send-key --key Enter (flag form)
     * 2. wezterm cli send-key Enter (positional form)
     * 3. CR byte via send-text --no-paste (final fallback)
     */
    async sendEnter(paneId) {
        // Level 1 & 2: try send-key with both key variants
        for (const key of ['Enter', 'Return']) {
            // Flag form: --key Enter
            try {
                await execFileAsync(this.weztermBin, [
                    'cli', 'send-key', '--pane-id', paneId, '--key', key,
                ], { ...subprocessOpts(), timeout: 1000 });
                return;
            }
            catch { /* try next variant */ }
            // Positional form: send-key Enter
            try {
                await execFileAsync(this.weztermBin, [
                    'cli', 'send-key', '--pane-id', paneId, key,
                ], { ...subprocessOpts(), timeout: 1000 });
                return;
            }
            catch { /* try next */ }
        }
        // Level 3: CR byte via send-text
        const opts = { ...subprocessOpts(), input: '\r' };
        await execFileAsync(this.weztermBin, [
            'cli', 'send-text', '--pane-id', paneId, '--no-paste',
        ], opts);
    }
    async isAlive(paneId) {
        try {
            const { stdout } = await execFileAsync(this.weztermBin, [
                'cli', 'list', '--format', 'json',
            ], subprocessOpts());
            const panes = JSON.parse(stdout);
            return panes.some(p => String(p.pane_id) === paneId);
        }
        catch {
            // Fallback: plain text parsing
            try {
                const { stdout } = await execFileAsync(this.weztermBin, [
                    'cli', 'list',
                ], subprocessOpts());
                return stdout.includes(paneId);
            }
            catch {
                return false;
            }
        }
    }
    async getText(paneId, lines = 50) {
        const { stdout } = await execFileAsync(this.weztermBin, [
            'cli', 'get-text', '--pane-id', paneId,
        ], { ...subprocessOpts(), timeout: 2000 });
        // Return last N lines
        const allLines = stdout.split('\n');
        return allLines.slice(-lines).join('\n');
    }
    async killPane(paneId) {
        try {
            // WezTerm: send exit command to gracefully close the pane
            await this.sendText(paneId, 'exit');
        }
        catch { /* best effort */ }
    }
}
// ---------------------------------------------------------------------------
// Auto-detection — tmux first (inner env when running wezterm+tmux)
// ---------------------------------------------------------------------------
export function detectBackend() {
    if (process.env.TMUX || process.env.TMUX_PANE) {
        return new TmuxBackend();
    }
    if (process.env.WEZTERM_PANE) {
        return new WeztermBackend();
    }
    return null;
}
//# sourceMappingURL=terminal-backend.js.map