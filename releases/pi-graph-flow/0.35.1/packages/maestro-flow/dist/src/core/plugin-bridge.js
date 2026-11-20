// ---------------------------------------------------------------------------
// Plugin Bridge — register maestro assets as native Claude Code / Codex plugins
//
// Builds a local staging directory with the correct layout for each platform,
// generates marketplace/plugin manifest files, then calls the official CLI
// to register the marketplace and install the plugin.
// ---------------------------------------------------------------------------
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, writeFileSync, readFileSync, rmSync, } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { paths } from '../config/paths.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BRIDGE_DIR = join(paths.home, 'plugin-bridge');
const CLAUDE_STAGING = join(BRIDGE_DIR, 'claude');
const CODEX_STAGING = join(BRIDGE_DIR, 'codex');
const STATE_FILE = join(BRIDGE_DIR, 'state.json');
const MARKETPLACE_NAME = 'maestro-flow-bridge';
const PLUGIN_NAME = 'maestro-flow';
// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
export function loadState() {
    if (!existsSync(STATE_FILE))
        return {};
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
    catch {
        return {};
    }
}
function saveState(state) {
    mkdirSync(BRIDGE_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}
// ---------------------------------------------------------------------------
// Recursive copy helper
// ---------------------------------------------------------------------------
function copyDirRecursive(src, dest) {
    if (!existsSync(src))
        return 0;
    const st = statSync(src);
    if (st.isFile()) {
        const dir = join(dest, '..');
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        copyFileSync(src, dest);
        return 1;
    }
    if (!existsSync(dest))
        mkdirSync(dest, { recursive: true });
    let count = 0;
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
            count += copyDirRecursive(srcPath, destPath);
        }
        else {
            copyFileSync(srcPath, destPath);
            count++;
        }
    }
    return count;
}
// ---------------------------------------------------------------------------
// Scan helpers — count skills/agents/commands
// ---------------------------------------------------------------------------
function countSubdirs(dir) {
    if (!existsSync(dir))
        return 0;
    return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
}
function countFiles(dir, ext) {
    if (!existsSync(dir))
        return 0;
    return readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && (!ext || e.name.endsWith(ext)))
        .length;
}
// ---------------------------------------------------------------------------
// Build Claude staging
// ---------------------------------------------------------------------------
export function buildClaudeStaging(pkgRoot, version) {
    const pluginDir = join(CLAUDE_STAGING, 'plugins', PLUGIN_NAME);
    // Clean existing staging
    if (existsSync(CLAUDE_STAGING)) {
        rmSync(CLAUDE_STAGING, { recursive: true, force: true });
    }
    // Create directory structure
    mkdirSync(join(CLAUDE_STAGING, '.claude-plugin'), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
    // Copy skills, agents, commands from package
    const skillsSrc = join(pkgRoot, '.claude', 'skills');
    const agentsSrc = join(pkgRoot, '.claude', 'agents');
    const commandsSrc = join(pkgRoot, '.claude', 'commands');
    const skillFiles = copyDirRecursive(skillsSrc, join(pluginDir, 'skills'));
    const agentFiles = copyDirRecursive(agentsSrc, join(pluginDir, 'agents'));
    const commandFiles = copyDirRecursive(commandsSrc, join(pluginDir, 'commands'));
    const skillCount = countSubdirs(join(pluginDir, 'skills'));
    const agentCount = countFiles(join(pluginDir, 'agents'), '.md');
    const commandCount = countFiles(join(pluginDir, 'commands'), '.md');
    // Generate plugin.json
    writeFileSync(join(pluginDir, 'plugin.json'), JSON.stringify({
        name: PLUGIN_NAME,
        version,
        description: 'Maestro Flow — workflow orchestration with MCP support',
        author: { name: 'maestro-flow' },
        category: 'productivity',
    }, null, 2), 'utf-8');
    // Generate marketplace.json
    writeFileSync(join(CLAUDE_STAGING, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
        name: MARKETPLACE_NAME,
        description: 'Local marketplace for Maestro Flow',
        owner: { name: 'maestro-flow' },
        plugins: [{
                name: PLUGIN_NAME,
                description: `Maestro Flow v${version} — ${skillCount} skills, ${agentCount} agents, ${commandCount} commands`,
                source: `./plugins/${PLUGIN_NAME}`,
                category: 'productivity',
            }],
    }, null, 2), 'utf-8');
    return { skills: skillCount, agents: agentCount, commands: commandCount };
}
// ---------------------------------------------------------------------------
// Build Codex staging
// ---------------------------------------------------------------------------
export function buildCodexStaging(pkgRoot, version) {
    const pluginDir = join(CODEX_STAGING, 'plugins', PLUGIN_NAME);
    // Clean existing staging
    if (existsSync(CODEX_STAGING)) {
        rmSync(CODEX_STAGING, { recursive: true, force: true });
    }
    // Create directory structure
    mkdirSync(join(CODEX_STAGING, '.agents', 'plugins'), { recursive: true });
    mkdirSync(join(pluginDir, '.codex-plugin'), { recursive: true });
    // Copy codex skills
    const skillsSrc = join(pkgRoot, '.codex', 'skills');
    const skillFiles = copyDirRecursive(skillsSrc, join(pluginDir, 'skills'));
    const skillCount = countSubdirs(join(pluginDir, 'skills'));
    // Generate .codex-plugin/plugin.json
    writeFileSync(join(pluginDir, '.codex-plugin', 'plugin.json'), JSON.stringify({
        name: PLUGIN_NAME,
        version,
        description: `Maestro Flow — ${skillCount} skills for Codex`,
        author: { name: 'maestro-flow' },
        skills: './skills/',
        interface: {
            displayName: 'Maestro Flow',
            shortDescription: 'Workflow orchestration CLI with MCP support',
            category: 'Productivity',
        },
    }, null, 2), 'utf-8');
    // Generate marketplace.json
    writeFileSync(join(CODEX_STAGING, '.agents', 'plugins', 'marketplace.json'), JSON.stringify({
        name: MARKETPLACE_NAME,
        interface: { displayName: 'Maestro Flow' },
        plugins: [{
                name: PLUGIN_NAME,
                source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
                policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
                category: 'Productivity',
            }],
    }, null, 2), 'utf-8');
    return { skills: skillCount, agents: 0, commands: 0 };
}
function execCli(cmd, args) {
    const isWin = process.platform === 'win32';
    try {
        const output = execFileSync(isWin ? 'cmd' : cmd, isWin ? ['/c', cmd, ...args] : args, { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
        return { success: true, output: output.trim() };
    }
    catch (err) {
        const msg = err instanceof Error ? err.stderr || err.message : String(err);
        return { success: false, output: typeof msg === 'string' ? msg.trim() : String(msg) };
    }
}
function cliAvailable(cmd) {
    const isWin = process.platform === 'win32';
    try {
        execFileSync(isWin ? 'cmd' : cmd, isWin ? ['/c', cmd, '--version'] : ['--version'], { encoding: 'utf-8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Register / Unregister — Claude Code
// ---------------------------------------------------------------------------
export function registerClaudePlugin() {
    // Add local marketplace
    const addResult = execCli('claude', ['plugin', 'marketplace', 'add', CLAUDE_STAGING]);
    if (!addResult.success)
        return addResult;
    // Install plugin from marketplace
    const installResult = execCli('claude', ['plugin', 'install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    return installResult;
}
export function unregisterClaudePlugin() {
    // Uninstall plugin
    execCli('claude', ['plugin', 'uninstall', PLUGIN_NAME]);
    // Remove marketplace
    const result = execCli('claude', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    // Clean plugin cache — CLI uninstall leaves cached files behind
    const cacheDir = join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE_NAME);
    if (existsSync(cacheDir)) {
        try {
            rmSync(cacheDir, { recursive: true, force: true });
        }
        catch { /* skip */ }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Register / Unregister — Codex
// ---------------------------------------------------------------------------
export function registerCodexPlugin() {
    // Add local marketplace
    const addResult = execCli('codex', ['plugin', 'marketplace', 'add', CODEX_STAGING]);
    if (!addResult.success)
        return addResult;
    // Install plugin from marketplace
    const installResult = execCli('codex', ['plugin', 'add', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    return installResult;
}
export function unregisterCodexPlugin() {
    // Remove plugin
    execCli('codex', ['plugin', 'remove', PLUGIN_NAME]);
    // Remove marketplace
    const result = execCli('codex', ['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    // Clean plugin cache — CLI remove leaves cached files behind
    const cacheDir = join(homedir(), '.codex', 'plugins', 'cache', MARKETPLACE_NAME);
    if (existsSync(cacheDir)) {
        try {
            rmSync(cacheDir, { recursive: true, force: true });
        }
        catch { /* skip */ }
    }
    return result;
}
export function getClaudeStatus() {
    if (!cliAvailable('claude')) {
        return { cliAvailable: false, marketplaceRegistered: false, pluginInstalled: false, detail: 'CLI not found' };
    }
    const listResult = execCli('claude', ['plugin', 'list']);
    const hasPlugin = listResult.success && listResult.output.includes(PLUGIN_NAME);
    const mpResult = execCli('claude', ['plugin', 'marketplace', 'list']);
    const hasMp = mpResult.success && mpResult.output.includes(MARKETPLACE_NAME);
    return {
        cliAvailable: true,
        marketplaceRegistered: hasMp,
        pluginInstalled: hasPlugin,
        detail: hasPlugin ? 'installed' : (hasMp ? 'marketplace registered, plugin not installed' : 'not registered'),
    };
}
export function getCodexStatus() {
    if (!cliAvailable('codex')) {
        return { cliAvailable: false, marketplaceRegistered: false, pluginInstalled: false, detail: 'CLI not found' };
    }
    const listResult = execCli('codex', ['plugin', 'list']);
    const hasPlugin = listResult.success && listResult.output.includes(PLUGIN_NAME) && listResult.output.includes('installed');
    const mpResult = execCli('codex', ['plugin', 'marketplace', 'list']);
    const hasMp = mpResult.success && mpResult.output.includes(MARKETPLACE_NAME);
    return {
        cliAvailable: true,
        marketplaceRegistered: hasMp,
        pluginInstalled: hasPlugin,
        detail: hasPlugin ? 'installed' : (hasMp ? 'marketplace registered, plugin not installed' : 'not registered'),
    };
}
export function installPlugin(pkgRoot, version, opts) {
    const doClaude = opts?.claude ?? true;
    const doCodex = opts?.codex ?? true;
    const result = {
        claude: { success: false, detail: '', stats: { skills: 0, agents: 0, commands: 0 } },
        codex: { success: false, detail: '', stats: { skills: 0, agents: 0, commands: 0 } },
    };
    const state = loadState();
    if (doClaude) {
        if (!cliAvailable('claude')) {
            result.claude.detail = 'claude CLI not found — skipped';
        }
        else {
            // Build staging
            result.claude.stats = buildClaudeStaging(pkgRoot, version);
            // Unregister first (idempotent)
            unregisterClaudePlugin();
            // Register
            const reg = registerClaudePlugin();
            result.claude.success = reg.success;
            result.claude.detail = reg.success
                ? `${result.claude.stats.skills} skills, ${result.claude.stats.agents} agents, ${result.claude.stats.commands} commands`
                : reg.output;
            if (reg.success) {
                state.claude = {
                    installed: true,
                    version,
                    installedAt: new Date().toISOString(),
                    stagingDir: CLAUDE_STAGING,
                };
            }
        }
    }
    if (doCodex) {
        if (!cliAvailable('codex')) {
            result.codex.detail = 'codex CLI not found — skipped';
        }
        else {
            // Build staging
            result.codex.stats = buildCodexStaging(pkgRoot, version);
            // Unregister first (idempotent)
            unregisterCodexPlugin();
            // Register
            const reg = registerCodexPlugin();
            result.codex.success = reg.success;
            result.codex.detail = reg.success
                ? `${result.codex.stats.skills} skills`
                : reg.output;
            if (reg.success) {
                state.codex = {
                    installed: true,
                    version,
                    installedAt: new Date().toISOString(),
                    stagingDir: CODEX_STAGING,
                };
            }
        }
    }
    saveState(state);
    return result;
}
export function uninstallPlugin(opts) {
    const doClaude = opts?.claude ?? true;
    const doCodex = opts?.codex ?? true;
    const clean = opts?.cleanStaging ?? true;
    const result = { claude: '', codex: '' };
    const state = loadState();
    if (doClaude) {
        if (!cliAvailable('claude')) {
            result.claude = 'claude CLI not found — skipped';
        }
        else {
            const res = unregisterClaudePlugin();
            result.claude = res.success ? 'uninstalled' : res.output;
            if (clean && existsSync(CLAUDE_STAGING)) {
                rmSync(CLAUDE_STAGING, { recursive: true, force: true });
            }
            delete state.claude;
        }
    }
    if (doCodex) {
        if (!cliAvailable('codex')) {
            result.codex = 'codex CLI not found — skipped';
        }
        else {
            const res = unregisterCodexPlugin();
            result.codex = res.success ? 'uninstalled' : res.output;
            if (clean && existsSync(CODEX_STAGING)) {
                rmSync(CODEX_STAGING, { recursive: true, force: true });
            }
            delete state.codex;
        }
    }
    saveState(state);
    return result;
}
//# sourceMappingURL=plugin-bridge.js.map