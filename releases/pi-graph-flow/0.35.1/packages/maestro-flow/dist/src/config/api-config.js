// ---------------------------------------------------------------------------
// Unified API endpoint configuration loader
//
// Reads ~/.maestro/api.json for all LLM API endpoints, proxy, and
// circuit breaker config. Reads ~/.maestro/moa.json for MOA presets.
// Falls back to ~/.maestro/api-explore.json for one version cycle.
// ---------------------------------------------------------------------------
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
const API_JSON_PATH = join(homedir(), '.maestro', 'api.json');
const API_EXPLORE_PATH = join(homedir(), '.maestro', 'api-explore.json');
const MOA_JSON_PATH = join(homedir(), '.maestro', 'moa.json');
const CLI_TOOLS_PATH = join(homedir(), '.maestro', 'cli-tools.json');
function readJsonSync(path) {
    if (!existsSync(path))
        return null;
    try {
        return JSON.parse(readFileSync(path, 'utf-8'));
    }
    catch {
        return null;
    }
}
/**
 * Load API endpoint configuration.
 * Priority: api.json → api-explore.json (deprecated fallback) → empty.
 */
export function loadApiConfig() {
    return readJsonSync(API_JSON_PATH)
        ?? readJsonSync(API_EXPLORE_PATH)
        ?? {};
}
/**
 * Load MOA preset configuration.
 * Priority: moa.json → api-explore.json .moa field → undefined.
 */
export function loadMoaConfig() {
    const moaFile = readJsonSync(MOA_JSON_PATH);
    if (moaFile)
        return moaFile;
    const legacy = readJsonSync(API_EXPLORE_PATH);
    return legacy?.moa;
}
/**
 * Resolve proxy configuration.
 * Priority: api.json proxy → api-explore.json proxy → cli-tools.json proxy.
 */
export function resolveProxyConfig() {
    const apiConfig = readJsonSync(API_JSON_PATH);
    if (apiConfig?.proxy)
        return apiConfig.proxy;
    const legacyConfig = readJsonSync(API_EXPLORE_PATH);
    if (legacyConfig?.proxy)
        return legacyConfig.proxy;
    const cliToolsConfig = readJsonSync(CLI_TOOLS_PATH);
    return cliToolsConfig?.proxy;
}
//# sourceMappingURL=api-config.js.map