import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.js';
import { inspectWorkspaceLink } from '../repository/context.js';
import { updateFileAtomic } from '../utils/atomic-write.js';
const DEFAULT_CONFIG = {
    version: '0.1.0',
    extensions: [],
    mcp: {
        port: 3600,
        host: 'localhost',
        enabledTools: ['all'],
    },
    workflows: {
        templatesDir: 'templates',
        workflowsDir: 'workflows',
    },
    hooks: {
        toggles: { telemetry: true, workflowGuard: false, promptGuard: false },
        external: [],
        plugins: [],
    },
};
export function loadConfig() {
    if (!existsSync(paths.config)) {
        return { ...DEFAULT_CONFIG };
    }
    const raw = readFileSync(paths.config, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}
export function saveConfig(config) {
    paths.ensure(paths.home);
    writeFileSync(paths.config, JSON.stringify(config, null, 2));
}
// ---------------------------------------------------------------------------
// Spec Injection Config — project-level (.workflow/config.json)
// ---------------------------------------------------------------------------
export function loadSpecInjectionConfig(projectPath) {
    const configPath = join(projectPath, '.workflow', 'config.json');
    if (!existsSync(configPath))
        return {};
    try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        return raw.specInjection ?? {};
    }
    catch {
        return {};
    }
}
export function saveSpecInjectionConfig(projectPath, config) {
    const configPath = join(projectPath, '.workflow', 'config.json');
    let existing = {};
    try {
        existing = JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    catch {
        // Start fresh
    }
    existing['specInjection'] = config;
    writeFileSync(configPath, JSON.stringify(existing, null, 2), 'utf-8');
}
// ---------------------------------------------------------------------------
// Spec Analytics Config — nested under specInjection.analytics
// ---------------------------------------------------------------------------
export function loadAnalyticsConfig(projectPath) {
    const injConfig = loadSpecInjectionConfig(projectPath);
    return injConfig.analytics ?? { enabled: true };
}
export function saveAnalyticsConfig(projectPath, config) {
    const injConfig = loadSpecInjectionConfig(projectPath);
    injConfig.analytics = config;
    saveSpecInjectionConfig(projectPath, injConfig);
}
export function loadWorkspaceConfig(projectPath) {
    const configPath = join(projectPath, '.workflow', 'config.json');
    if (!existsSync(configPath))
        return { linked: [] };
    try {
        const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
        const ws = raw.workspaces;
        if (!ws || !Array.isArray(ws.linked))
            return { linked: [] };
        return {
            linked: ws.linked.map(link => ({
                ...link,
                share: Array.isArray(link.share) ? link.share : [],
                // Legacy links remain readable but never acquire write authority.
                write: Array.isArray(link.write) ? link.write : [],
            })),
        };
    }
    catch {
        return { linked: [] };
    }
}
export function saveWorkspaceConfig(projectPath, config) {
    const configPath = join(projectPath, '.workflow', 'config.json');
    paths.ensure(join(projectPath, '.workflow'));
    updateFileAtomic(configPath, current => {
        let existing = {};
        try {
            existing = current ? JSON.parse(current) : {};
        }
        catch {
            // Preserve historical recovery behavior for malformed project config.
        }
        existing['workspaces'] = config;
        return JSON.stringify(existing, null, 2);
    });
}
export function resolveWorkspaceLinks(projectPath, config) {
    const aliasCounts = new Map();
    for (const link of config.linked)
        aliasCounts.set(link.name, (aliasCounts.get(link.name) ?? 0) + 1);
    return config.linked.map(link => {
        const inspected = inspectWorkspaceLink(projectPath, link);
        if ((aliasCounts.get(link.name) ?? 0) > 1) {
            inspected.valid = false;
            inspected.error = `Ambiguous linked repository alias: ${link.name}`;
        }
        return {
            ...link,
            write: link.write ?? [],
            ...inspected,
        };
    });
}
// ---------------------------------------------------------------------------
// Hooks Config
// ---------------------------------------------------------------------------
const DEFAULT_HOOKS = {
    toggles: {},
    external: [],
    plugins: [],
};
/** Convert user-facing hook names to the canonical config key used by runners. */
export function normalizeHookToggleKey(name) {
    return name.trim().replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}
/**
 * Normalize persisted aliases while giving an explicitly canonical key
 * precedence when both forms are present.
 */
export function normalizeHookToggles(toggles) {
    const normalized = {};
    const entries = Object.entries(toggles ?? {});
    for (const [name, enabled] of entries) {
        normalized[normalizeHookToggleKey(name)] = enabled;
    }
    for (const [name, enabled] of entries) {
        if (name === normalizeHookToggleKey(name))
            normalized[name] = enabled;
    }
    return normalized;
}
function readHooksFromFile(filePath) {
    if (!existsSync(filePath))
        return undefined;
    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        return raw.hooks;
    }
    catch {
        return undefined;
    }
}
export function loadHooksConfig() {
    // 1. Read global config hooks
    const globalHooks = readHooksFromFile(paths.config);
    // 2. Read project config hooks
    const projectConfigPath = join(process.cwd(), '.maestro', 'config.json');
    const projectHooks = readHooksFromFile(projectConfigPath);
    // 3. Merge: project overrides global; arrays concatenated
    const toggles = {
        ...normalizeHookToggles(globalHooks?.toggles),
        ...normalizeHookToggles(projectHooks?.toggles),
    };
    const external = [
        ...(globalHooks?.external ?? []),
        ...(projectHooks?.external ?? []),
    ];
    const plugins = [
        ...(globalHooks?.plugins ?? []),
        ...(projectHooks?.plugins ?? []),
    ];
    const merged = { toggles, external, plugins };
    // 4. Apply env var overrides
    const disable = process.env.MAESTRO_HOOKS_DISABLE;
    if (disable) {
        for (const name of disable.split(',').map((s) => s.trim()).filter(Boolean)) {
            merged.toggles[normalizeHookToggleKey(name)] = false;
        }
    }
    const enable = process.env.MAESTRO_HOOKS_ENABLE;
    if (enable) {
        for (const name of enable.split(',').map((s) => s.trim()).filter(Boolean)) {
            merged.toggles[normalizeHookToggleKey(name)] = true;
        }
    }
    // 5. Return with defaults for any missing fields
    return {
        toggles: merged.toggles ?? DEFAULT_HOOKS.toggles,
        external: merged.external ?? DEFAULT_HOOKS.external,
        plugins: merged.plugins ?? DEFAULT_HOOKS.plugins,
    };
}
//# sourceMappingURL=index.js.map