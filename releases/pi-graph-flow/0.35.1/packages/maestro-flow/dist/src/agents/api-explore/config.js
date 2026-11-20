import { loadApiConfig, loadMoaConfig, resolveProxyConfig, } from '../../config/api-config.js';
export const DEFAULT_EXPLORE_MAX_TURNS = 5;
export function loadExploreConfig() {
    const api = loadApiConfig();
    const moa = loadMoaConfig();
    return { ...api, moa };
}
export function getDefaultEndpoint(config) {
    const model = config.model || process.env.API_EXPLORE_MODEL || '';
    const baseUrl = config.baseUrl || process.env.API_EXPLORE_BASE_URL || '';
    const apiKey = config.apiKey || process.env.API_EXPLORE_API_KEY || process.env.OPENAI_API_KEY || '';
    if (!model || !baseUrl || !apiKey)
        return null;
    const format = (config.format ?? 'openai');
    return { model, baseUrl, apiKey, format, extraBody: config.extraBody };
}
export function getNamedEndpoint(name, config) {
    const ep = config.endpoints?.[name];
    if (!ep || !ep.model || !ep.baseUrl || !ep.apiKey)
        return null;
    const format = (ep.format ?? 'openai');
    return { model: ep.model, baseUrl: ep.baseUrl, apiKey: ep.apiKey, format, extraBody: ep.extraBody };
}
export const DEFAULT_PIPELINE = [
    { type: 'reference', prompt: '{{query}}' },
    { type: 'aggregate', prompt: '{{query}}\n\n{{references}}' },
];
export function getAllEndpoints(config) {
    const results = [];
    const def = getDefaultEndpoint(config);
    if (def) {
        results.push({ name: 'default', llmConfig: def });
    }
    if (config.endpoints) {
        for (const [name, ep] of Object.entries(config.endpoints)) {
            if (!ep.model || !ep.baseUrl || !ep.apiKey)
                continue;
            const fmt = (ep.format ?? 'openai');
            results.push({
                name,
                llmConfig: { model: ep.model, baseUrl: ep.baseUrl, apiKey: ep.apiKey, format: fmt, extraBody: ep.extraBody },
                maxTurns: ep.maxTurns,
                concurrency: ep.concurrency,
            });
        }
    }
    return results;
}
export function resolveEndpoints(config, endpointFilter, all) {
    if (endpointFilter) {
        const names = endpointFilter.split(',').map(s => s.trim()).filter(Boolean);
        const results = [];
        for (const name of names) {
            const ep = name === 'default' ? getDefaultEndpoint(config) : getNamedEndpoint(name, config);
            const epConfig = config.endpoints?.[name];
            if (ep)
                results.push({ name, llmConfig: ep, maxTurns: epConfig?.maxTurns, concurrency: epConfig?.concurrency });
        }
        return results;
    }
    if (all)
        return getAllEndpoints(config);
    const allEps = getAllEndpoints(config);
    return allEps.length > 0 ? [allEps[0]] : [];
}
/**
 * Resolve the proxy URL for explore HTTP requests.
 * Priority: config.proxy → api.json proxy → api-explore.json proxy → cli-tools.json proxy.
 */
export function resolveExploreProxyUrl(config) {
    const proxy = config.proxy ?? resolveProxyConfig();
    if (!proxy?.enabled)
        return undefined;
    return proxy.httpsProxy ?? proxy.httpProxy;
}
export function injectProxy(endpoints, proxyUrl) {
    if (!proxyUrl)
        return;
    for (const ep of endpoints) {
        ep.llmConfig = { ...ep.llmConfig, proxyUrl };
    }
}
export const MOA_MAX_REFERENCES = 4;
export function resolveMoaPreset(config, presetName) {
    if (!config.moa)
        return null;
    const name = presetName ?? config.moa.defaultPreset ?? 'default';
    const preset = config.moa.presets[name];
    if (!preset || preset.enabled === false)
        return null;
    if (preset.referenceEndpoints.length > MOA_MAX_REFERENCES) {
        throw new Error(`MOA preset referenceEndpoints exceeds max of ${MOA_MAX_REFERENCES}`);
    }
    const resolveEp = (epName) => {
        const llmConfig = epName === 'default' ? getDefaultEndpoint(config) : getNamedEndpoint(epName, config);
        if (!llmConfig)
            return null;
        const epConfig = config.endpoints?.[epName];
        return { name: epName, llmConfig, maxTurns: epConfig?.maxTurns };
    };
    const refEndpoints = preset.referenceEndpoints
        .map(resolveEp)
        .filter((ep) => ep !== null);
    const aggEndpoint = resolveEp(preset.aggregatorEndpoint);
    if (!aggEndpoint)
        return null;
    return {
        referenceEndpoints: refEndpoints,
        aggregatorEndpoint: aggEndpoint,
        steps: (preset.steps ?? DEFAULT_PIPELINE),
    };
}
//# sourceMappingURL=config.js.map