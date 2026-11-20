// ---------------------------------------------------------------------------
// CLI Tools configuration loader
// Reads ~/.maestro/cli-tools.json for tool selection and model routing.
// Supports role-based tool selection and workspace-level config overrides.
// ---------------------------------------------------------------------------
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import cliToolsDefaults from './cli-tools-defaults.json' with { type: 'json' };
// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Domain tags for tool expertise matching. */
export const DOMAIN_TAGS = [
    'frontend', 'backend', 'fullstack', 'devops', 'data', 'mobile', 'infra',
];
/** Reasoning effort levels for thinking models. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'max'];
// ---------------------------------------------------------------------------
// Default role mappings
// ---------------------------------------------------------------------------
/** Fixed set of supported roles. */
export const DELEGATE_ROLES = [
    'analyze', 'explore', 'review', 'implement', 'plan', 'brainstorm', 'research',
];
// Loaded from cli-tools-defaults.json — edit that file to change defaults.
const DEFAULT_ROLE_MAPPINGS = cliToolsDefaults.roleMappings;
// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
    version: '1.0.0',
    tools: {},
};
// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------
/**
 * Load CLI tools configuration with workspace-level overrides.
 *
 * Priority: {workDir}/.maestro/cli-tools.json > ~/.maestro/cli-tools.json > DEFAULT_CONFIG
 *
 * Merge strategy:
 * - tools: deep merge (workspace overrides same-name tools)
 * - roles: deep merge (workspace overrides same-name roles)
 */
export async function loadCliToolsConfig(workDir) {
    // 1. Load global config
    const globalPath = join(homedir(), '.maestro', 'cli-tools.json');
    let global = DEFAULT_CONFIG;
    try {
        const raw = await readFile(globalPath, 'utf-8');
        const parsed = JSON.parse(raw);
        global = { ...DEFAULT_CONFIG, ...parsed, tools: { ...parsed.tools } };
    }
    catch {
        // No global config — use defaults
    }
    // 2. Load workspace config (if workDir provided)
    if (workDir) {
        const workspacePath = join(workDir, '.maestro', 'cli-tools.json');
        try {
            const raw = await readFile(workspacePath, 'utf-8');
            const workspace = JSON.parse(raw);
            // Merge: workspace overrides global
            global = {
                version: workspace.version ?? global.version,
                tools: { ...global.tools, ...workspace.tools },
                roles: { ...global.roles, ...workspace.roles },
                proxy: workspace.proxy ?? global.proxy,
            };
        }
        catch {
            // No workspace config — use global as-is
        }
    }
    return global;
}
/**
 * Select a tool by explicit name or fall back to the first enabled tool.
 * Returns undefined when no tool can be resolved.
 */
export function selectTool(name, config) {
    const tools = config.tools ?? {};
    // Exact match by name
    if (name && tools[name]?.enabled) {
        return { name, entry: tools[name] };
    }
    // Fallback: first enabled tool in config order
    for (const [toolName, entry] of Object.entries(tools)) {
        if (entry.enabled) {
            return { name: toolName, entry };
        }
    }
    return undefined;
}
/**
 * Select a tool by capability role.
 *
 * Resolution order:
 * 1. User-configured role mapping (config.roles[role])
 * 2. Built-in default role mapping (DEFAULT_ROLE_MAPPINGS[role])
 * 3. If mapping has `tool` → direct selectTool()
 * 4. Walk `fallbackChain` → first enabled tool in chain
 * 5. Last resort → selectTool(undefined) (first enabled)
 */
export function selectToolByRole(role, config) {
    const mapping = config.roles?.[role] ?? DEFAULT_ROLE_MAPPINGS[role];
    if (!mapping) {
        return selectTool(undefined, config);
    }
    // Direct tool name
    if (mapping.tool) {
        return selectTool(mapping.tool, config);
    }
    // Fallback chain: try each named tool in order
    const tools = config.tools ?? {};
    if (mapping.fallbackChain) {
        for (const toolName of mapping.fallbackChain) {
            if (tools[toolName]?.enabled) {
                return { name: toolName, entry: tools[toolName] };
            }
        }
    }
    return selectTool(undefined, config);
}
// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
/**
 * Save CLI tools configuration to a specific scope.
 * Reads existing config, deep-merges the update, and writes back.
 */
export async function saveCliToolsConfig(update, scope, workDir) {
    const configPath = scope === 'global'
        ? join(homedir(), '.maestro', 'cli-tools.json')
        : join(workDir ?? process.cwd(), '.maestro', 'cli-tools.json');
    // Read existing
    let existing = {};
    try {
        const raw = await readFile(configPath, 'utf-8');
        existing = JSON.parse(raw);
    }
    catch {
        // No existing config
    }
    // Deep merge — tool entries are field-level merged, not replaced wholesale
    const mergedTools = { ...existing.tools };
    if (update.tools) {
        for (const [name, entry] of Object.entries(update.tools)) {
            mergedTools[name] = { ...mergedTools[name], ...entry };
        }
    }
    const merged = {
        version: update.version ?? existing.version ?? '1.1.0',
        tools: mergedTools,
        roles: { ...existing.roles, ...update.roles },
        proxy: update.proxy ?? existing.proxy,
    };
    // Ensure directory exists and write
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(merged, null, 2) + '\n');
}
// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------
/** Expose default role mappings for TUI display. */
export function getDefaultRoleMappings() {
    return { ...DEFAULT_ROLE_MAPPINGS };
}
/**
 * Rank enabled tools by domain tag relevance.
 * Returns tools sorted: exact tag match first, then fullstack, then rest.
 * Used by `maestro execute` to suggest the best tool for a task domain.
 */
export function rankToolsByDomain(domain, config) {
    const exact = [];
    const fullstack = [];
    const rest = [];
    for (const [name, entry] of Object.entries(config.tools ?? {})) {
        if (!entry.enabled)
            continue;
        const tool = { name, entry };
        if (entry.tags.includes(domain)) {
            exact.push(tool);
        }
        else if (entry.tags.includes('fullstack')) {
            fullstack.push(tool);
        }
        else {
            rest.push(tool);
        }
    }
    return [...exact, ...fullstack, ...rest];
}
// ---------------------------------------------------------------------------
// Proxy env resolution
// ---------------------------------------------------------------------------
function loadApiJsonProxy() {
    const apiJsonPath = join(homedir(), '.maestro', 'api.json');
    const apiExplorePath = join(homedir(), '.maestro', 'api-explore.json');
    for (const p of [apiJsonPath, apiExplorePath]) {
        if (!existsSync(p))
            continue;
        try {
            const raw = JSON.parse(readFileSync(p, 'utf-8'));
            if (raw.proxy)
                return raw.proxy;
        }
        catch { /* skip malformed */ }
    }
    return undefined;
}
/**
 * Build proxy environment variable overrides for a specific tool.
 * Returns an empty object when proxy is disabled globally or for the tool.
 * Proxy priority: api.json → api-explore.json → cli-tools.json config.proxy.
 */
export function resolveProxyEnv(config, toolName) {
    let proxy = config.proxy;
    if (!proxy?.enabled) {
        const apiProxy = loadApiJsonProxy();
        if (apiProxy?.enabled)
            proxy = apiProxy;
    }
    if (!proxy?.enabled)
        return {};
    const toolEntry = config.tools?.[toolName];
    if (toolEntry?.proxy === false)
        return {};
    const env = {};
    const httpUrl = proxy.httpProxy;
    const httpsUrl = proxy.httpsProxy ?? httpUrl;
    if (httpUrl) {
        env.HTTP_PROXY = httpUrl;
        env.http_proxy = httpUrl;
    }
    if (httpsUrl) {
        env.HTTPS_PROXY = httpsUrl;
        env.https_proxy = httpsUrl;
    }
    if (proxy.noProxy) {
        env.NO_PROXY = proxy.noProxy;
        env.no_proxy = proxy.noProxy;
    }
    return env;
}
/**
 * Quick TCP probe to check if the proxy is reachable.
 * Returns true if a connection can be established within the timeout.
 */
export async function checkProxyReachable(proxyUrl, timeoutMs = 3000) {
    let host;
    let port;
    try {
        const url = new URL(proxyUrl);
        host = url.hostname;
        port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    }
    catch {
        return false;
    }
    const { createConnection } = await import('node:net');
    return new Promise((resolve) => {
        const socket = createConnection({ host, port, timeout: timeoutMs }, () => {
            socket.destroy();
            resolve(true);
        });
        socket.on('error', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
        });
    });
}
/** Load global and workspace configs separately (un-merged) for introspection. */
export async function loadConfigSources(workDir) {
    const gp = join(homedir(), '.maestro', 'cli-tools.json');
    let g = null;
    try {
        g = JSON.parse(await readFile(gp, 'utf-8'));
    }
    catch { /* */ }
    let wp = null;
    let w = null;
    if (workDir) {
        wp = join(workDir, '.maestro', 'cli-tools.json');
        try {
            w = JSON.parse(await readFile(wp, 'utf-8'));
        }
        catch { /* */ }
    }
    return { globalPath: gp, global: g, workspacePath: wp, workspace: w };
}
// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------
/** CLI tool definitions — loaded from cli-tools-defaults.json. */
const TOOL_DEFS = cliToolsDefaults.tools;
function isCliAvailable(cmd) {
    try {
        execSync(`${cmd} --version`, { stdio: 'ignore', timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Reset ~/.maestro/cli-tools.json to defaults.
 * Re-detects CLI availability and overwrites the existing file.
 * Returns the new config.
 */
export async function resetCliToolsConfig() {
    const tools = {};
    for (const def of TOOL_DEFS) {
        tools[def.name] = {
            enabled: isCliAvailable(def.cmd),
            primaryModel: def.primaryModel,
            tags: def.tags,
            type: def.type,
        };
    }
    const config = { version: '1.1.0', tools };
    const configPath = join(homedir(), '.maestro', 'cli-tools.json');
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    return config;
}
function buildDefaultTools() {
    const tools = {};
    for (const def of TOOL_DEFS) {
        tools[def.name] = {
            enabled: isCliAvailable(def.cmd),
            primaryModel: def.primaryModel,
            tags: def.tags,
            type: def.type,
        };
    }
    return tools;
}
function mergeMissingToolDefs(existing) {
    const merged = { ...existing };
    const added = [];
    for (const def of TOOL_DEFS) {
        if (merged[def.name])
            continue; // preserve user-customized entries verbatim
        merged[def.name] = {
            enabled: isCliAvailable(def.cmd),
            primaryModel: def.primaryModel,
            tags: def.tags,
            type: def.type,
        };
        added.push(def.name);
    }
    return { merged, added };
}
/**
 * Initialize / upgrade ~/.maestro/cli-tools.json.
 *
 * - First install (file missing): create from defaults with availability detection.
 * - Upgrade (file present): merge defaults into existing — only adds tools that
 *   are missing. Existing entries (primaryModel, secondaryModel, settingsFile,
 *   reasoningEffort, tags, enabled) are preserved verbatim.
 *
 * Returns details about what changed.
 */
export async function initCliToolsConfig() {
    const configPath = join(homedir(), '.maestro', 'cli-tools.json');
    let existingRaw;
    try {
        existingRaw = await readFile(configPath, 'utf-8');
    }
    catch {
        // file missing — fall through to create
    }
    if (existingRaw === undefined) {
        const config = { version: '1.1.0', tools: buildDefaultTools() };
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
        return { changed: true, added: [], created: true };
    }
    let existing;
    try {
        existing = JSON.parse(existingRaw);
    }
    catch {
        // Malformed — leave it alone, don't blow away user data
        return { changed: false, added: [], created: false };
    }
    const { merged, added } = mergeMissingToolDefs(existing.tools ?? {});
    if (added.length === 0)
        return { changed: false, added: [], created: false };
    const next = { ...existing, version: existing.version ?? '1.1.0', tools: merged };
    await writeFile(configPath, JSON.stringify(next, null, 2) + '\n');
    return { changed: true, added, created: false };
}
/**
 * Synchronous version of initCliToolsConfig for non-async contexts (e.g. forceInstall).
 * Same semantics: first-install creates, upgrade merges only missing tool defs.
 */
export function initCliToolsConfigSync() {
    const configPath = join(homedir(), '.maestro', 'cli-tools.json');
    if (!existsSync(configPath)) {
        const config = { version: '1.1.0', tools: buildDefaultTools() };
        mkdirSync(dirname(configPath), { recursive: true });
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        return { changed: true, added: [], created: true };
    }
    let existing;
    try {
        existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    catch {
        return { changed: false, added: [], created: false };
    }
    const { merged, added } = mergeMissingToolDefs(existing.tools ?? {});
    if (added.length === 0)
        return { changed: false, added: [], created: false };
    const next = { ...existing, version: existing.version ?? '1.1.0', tools: merged };
    writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n');
    return { changed: true, added, created: false };
}
//# sourceMappingURL=cli-tools-config.js.map