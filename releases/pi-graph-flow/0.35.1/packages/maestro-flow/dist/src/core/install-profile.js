// ---------------------------------------------------------------------------
// Install Profile — export/import install configuration as JSON files
//
// Profile format: maestro-install-config/v1
// Storage: ~/.maestro/install-profiles/
// ---------------------------------------------------------------------------
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { getHooksForLevel } from '../commands/hooks.js';
import { MCP_TOOLS } from '../commands/install-backend.js';
import { findManifest, uniqueExtraMcpTargetIds } from './manifest.js';
import { COMPONENT_DEFS } from './component-defs.js';
import { paths } from '../config/paths.js';
const PROFILE_DIR = join(homedir(), '.maestro', 'install-profiles');
const SCHEMA_VERSION = 'maestro-install-config/v1';
function ensureProfileDir() {
    if (!existsSync(PROFILE_DIR)) {
        mkdirSync(PROFILE_DIR, { recursive: true });
    }
}
export function getProfileDir() {
    return PROFILE_DIR;
}
export function exportProfile(profile, filePath) {
    ensureProfileDir();
    const safeName = profile.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const target = filePath ? resolve(filePath) : join(PROFILE_DIR, `${safeName}.json`);
    if (filePath) {
        const resolved = resolve(filePath);
        if (!resolved.startsWith(PROFILE_DIR) && !resolved.startsWith(resolve(process.cwd()))) {
            throw new Error('Export path must be within profile directory or current directory');
        }
    }
    writeFileSync(target, JSON.stringify({ ...profile, $schema: SCHEMA_VERSION }, null, 2), 'utf-8');
    return target;
}
const VALID_SCOPES = ['global', 'project'];
const VALID_LEVELS = ['none', 'minimal', 'standard', 'full'];
function validateProfile(raw) {
    if (!raw.scope || !VALID_SCOPES.includes(raw.scope)) {
        throw new Error('Invalid profile: scope must be "global" or "project"');
    }
    const checkLevel = (path, val) => {
        if (val && !VALID_LEVELS.includes(val)) {
            throw new Error(`Invalid profile: ${path} must be one of ${VALID_LEVELS.join(', ')}`);
        }
    };
    const claude = raw.claude;
    const codex = raw.codex;
    const agy = raw.agy;
    checkLevel('claude.hooks.basePreset', claude?.hooks?.basePreset);
    checkLevel('codex.hooks.basePreset', codex?.hooks?.basePreset);
    checkLevel('agy.hooks.basePreset', agy?.hooks?.basePreset);
    const checkProjectRoot = (path, val) => {
        if (typeof val === 'string' && val && (val.includes('..') || val.includes('\0'))) {
            throw new Error(`Invalid profile: ${path} must not contain path traversal`);
        }
    };
    checkProjectRoot('claude.mcp.projectRoot', claude?.mcp?.projectRoot);
    checkProjectRoot('codex.mcp.projectRoot', codex?.mcp?.projectRoot);
}
export function importProfile(filePath) {
    if (!existsSync(filePath)) {
        throw new Error('Profile file not found');
    }
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    if (raw.$schema !== SCHEMA_VERSION) {
        throw new Error('Unsupported profile schema version');
    }
    validateProfile(raw);
    return raw;
}
/**
 * Build an InstallProfile directly from a Manifest object.
 * Used by `maestro update` reinstall — avoids the findManifest() lookup
 * since the caller already has the manifest in hand.
 */
export function manifestToProfile(manifest) {
    // hooks.claude.level (schema v2) takes precedence, then legacy hookLevel (v1), then default
    const claudeLevel = (manifest.hooks?.claude?.level ?? manifest.hookLevel ?? 'standard');
    const codexLevel = manifest.hooks?.codex?.level || 'none';
    const agyLevel = manifest.hooks?.agy?.level || 'none';
    // Bug fix: detect custom hook selections by comparing installed hooks with level preset
    const claudeInstalledHooks = manifest.hooks?.claude?.installed ?? [];
    const claudeLevelHooks = getHooksForLevel(claudeLevel, 'claude');
    const claudeIsCustom = claudeInstalledHooks.length > 0 &&
        JSON.stringify([...claudeInstalledHooks].sort()) !== JSON.stringify([...claudeLevelHooks].sort());
    const codexInstalledHooks = manifest.hooks?.codex?.installed ?? [];
    const codexLevelHooks = getHooksForLevel(codexLevel, 'codex');
    const codexIsCustom = codexInstalledHooks.length > 0 &&
        JSON.stringify([...codexInstalledHooks].sort()) !== JSON.stringify([...codexLevelHooks].sort());
    const agyInstalledHooks = manifest.hooks?.agy?.installed ?? [];
    const agyLevelHooks = getHooksForLevel(agyLevel, 'agy');
    const agyIsCustom = agyInstalledHooks.length > 0 &&
        JSON.stringify([...agyInstalledHooks].sort()) !== JSON.stringify([...agyLevelHooks].sort());
    // Only schema-v1 manifests used hookLevel as a proxy for a legacy full
    // install. Modern manifests have explicit MCP/statusline records and must
    // never infer them from the mere presence of hooks.
    const wasLegacyFullInstall = (!manifest.version || Number.parseInt(manifest.version, 10) < 2)
        && !!manifest.hookLevel;
    return {
        $schema: SCHEMA_VERSION,
        name: `reinstall-${manifest.scope}`,
        createdAt: new Date().toISOString(),
        scope: manifest.scope,
        components: {
            enabled: manifest.selectedComponentIds === undefined || manifest.selectedComponentIds.length > 0,
            selectedIds: manifest.selectedComponentIds !== undefined
                ? manifest.selectedComponentIds
                : COMPONENT_DEFS.filter(d => d.defaultSelected !== false).map(d => d.id),
            knownIds: manifest.knownComponentIds,
        },
        claude: {
            hooks: {
                enabled: !!(manifest.hooks?.claude?.installed?.length),
                basePreset: claudeLevel,
                selectedHooks: manifest.hooks?.claude?.installed ?? getHooksForLevel(claudeLevel, 'claude'),
                isCustom: claudeIsCustom,
            },
            mcp: {
                enabled: manifest.mcp?.claude ? true : wasLegacyFullInstall,
                tools: [...MCP_TOOLS],
                projectRoot: '',
            },
            statusline: {
                enabled: manifest.statusline ? true : wasLegacyFullInstall,
                theme: manifest.statusline?.theme || 'notion',
            },
        },
        codex: {
            hooks: {
                enabled: !!(manifest.hooks?.codex?.installed?.length),
                basePreset: codexLevel,
                selectedHooks: manifest.hooks?.codex?.installed ?? getHooksForLevel(codexLevel, 'codex'),
                isCustom: codexIsCustom,
            },
            mcp: {
                enabled: manifest.mcp?.codex ? true : wasLegacyFullInstall,
                tools: [...MCP_TOOLS],
                projectRoot: '',
            },
        },
        agy: {
            hooks: {
                enabled: !!(manifest.hooks?.agy?.installed?.length),
                basePreset: agyLevel,
                selectedHooks: manifest.hooks?.agy?.installed ?? getHooksForLevel(agyLevel, 'agy'),
                isCustom: agyIsCustom,
            },
        },
        genericHooks: Object.fromEntries(Object.entries(manifest.hooks?.generic ?? {}).map(([id, record]) => [id, (record.level ?? 'none')])),
        extraMcp: {
            enabled: !!(manifest.mcp?.extras?.length),
            targetIds: uniqueExtraMcpTargetIds(manifest.mcp?.extras),
        },
        backup: { claudeMd: true, all: false },
        plugin: manifest.plugin
            ? { enabled: !!(manifest.plugin.claude || manifest.plugin.codex), claude: !!manifest.plugin.claude, codex: !!manifest.plugin.codex }
            : undefined,
    };
}
export function exportProfileFromManifest(scope, filePath) {
    const targetPath = scope === 'global' ? paths.home : process.cwd();
    const manifest = findManifest(scope, targetPath);
    const claudeLevel = (manifest?.hooks?.claude?.level ?? manifest?.hookLevel ?? 'standard');
    const codexLevel = manifest?.hooks?.codex?.level || 'none';
    const agyLevel = manifest?.hooks?.agy?.level || 'none';
    // Detect custom hook selections by comparing installed hooks with level preset
    const claudeInstalledHooks = manifest?.hooks?.claude?.installed ?? [];
    const claudeLevelHooks = getHooksForLevel(claudeLevel, 'claude');
    const claudeIsCustom = claudeInstalledHooks.length > 0 &&
        JSON.stringify([...claudeInstalledHooks].sort()) !== JSON.stringify([...claudeLevelHooks].sort());
    const codexInstalledHooks = manifest?.hooks?.codex?.installed ?? [];
    const codexLevelHooks = getHooksForLevel(codexLevel, 'codex');
    const codexIsCustom = codexInstalledHooks.length > 0 &&
        JSON.stringify([...codexInstalledHooks].sort()) !== JSON.stringify([...codexLevelHooks].sort());
    const agyInstalledHooks = manifest?.hooks?.agy?.installed ?? [];
    const agyLevelHooks = getHooksForLevel(agyLevel, 'agy');
    const agyIsCustom = agyInstalledHooks.length > 0 &&
        JSON.stringify([...agyInstalledHooks].sort()) !== JSON.stringify([...agyLevelHooks].sort());
    // Only schema-v1 manifests used hookLevel as a full-install proxy.
    const wasLegacyFullInstall = !!manifest
        && (!manifest.version || Number.parseInt(manifest.version, 10) < 2)
        && !!manifest.hookLevel;
    const profile = {
        $schema: SCHEMA_VERSION,
        name: 'default',
        createdAt: new Date().toISOString(),
        scope,
        components: {
            enabled: manifest?.selectedComponentIds === undefined || manifest.selectedComponentIds.length > 0,
            selectedIds: manifest?.selectedComponentIds !== undefined
                ? manifest.selectedComponentIds
                : COMPONENT_DEFS.filter(d => d.defaultSelected !== false).map(d => d.id),
            knownIds: manifest?.knownComponentIds,
        },
        claude: {
            hooks: {
                enabled: !!(manifest?.hooks?.claude?.installed?.length),
                basePreset: claudeLevel,
                selectedHooks: manifest?.hooks?.claude?.installed ?? getHooksForLevel(claudeLevel, 'claude'),
                isCustom: claudeIsCustom,
            },
            mcp: {
                enabled: manifest?.mcp?.claude ? true : wasLegacyFullInstall,
                tools: [...MCP_TOOLS],
                projectRoot: '',
            },
            statusline: {
                enabled: manifest?.statusline ? true : wasLegacyFullInstall,
                theme: manifest?.statusline?.theme || 'notion',
            },
        },
        codex: {
            hooks: {
                enabled: !!(manifest?.hooks?.codex?.installed?.length),
                basePreset: codexLevel,
                selectedHooks: manifest?.hooks?.codex?.installed ?? getHooksForLevel(codexLevel, 'codex'),
                isCustom: codexIsCustom,
            },
            mcp: {
                enabled: manifest?.mcp?.codex ? true : wasLegacyFullInstall,
                tools: [...MCP_TOOLS],
                projectRoot: '',
            },
        },
        agy: {
            hooks: {
                enabled: !!(manifest?.hooks?.agy?.installed?.length),
                basePreset: agyLevel,
                selectedHooks: manifest?.hooks?.agy?.installed ?? getHooksForLevel(agyLevel, 'agy'),
                isCustom: agyIsCustom,
            },
        },
        genericHooks: Object.fromEntries(Object.entries(manifest?.hooks?.generic ?? {}).map(([id, record]) => [id, (record.level ?? 'none')])),
        extraMcp: {
            enabled: !!(manifest?.mcp?.extras?.length),
            targetIds: uniqueExtraMcpTargetIds(manifest?.mcp?.extras),
        },
        backup: { claudeMd: true, all: false },
    };
    return exportProfile(profile, filePath);
}
// ---------------------------------------------------------------------------
// Bidirectional conversion: InstallFlowConfig ↔ InstallProfile
// ---------------------------------------------------------------------------
export function configToProfile(config, name = 'default') {
    return {
        $schema: SCHEMA_VERSION,
        name,
        createdAt: new Date().toISOString(),
        scope: config.mode,
        components: {
            enabled: config.installComponents,
            selectedIds: config.selectedComponentIds,
            knownIds: COMPONENT_DEFS.map((def) => def.id),
        },
        claude: {
            hooks: {
                enabled: config.installHooks,
                basePreset: config.hookLevel,
                selectedHooks: config.claudeHooksSelection?.selectedHooks ?? getHooksForLevel(config.hookLevel, 'claude'),
                isCustom: config.claudeHooksSelection?.isCustom ?? false,
            },
            mcp: { enabled: config.installMcp, tools: config.mcpTools, projectRoot: config.mcpProjectRoot },
            statusline: { enabled: config.installStatusline, theme: config.statuslineTheme },
        },
        codex: {
            hooks: {
                enabled: config.installCodexHooks,
                basePreset: config.codexHookLevel,
                selectedHooks: config.codexHooksSelection?.selectedHooks ?? getHooksForLevel(config.codexHookLevel, 'codex'),
                isCustom: config.codexHooksSelection?.isCustom ?? false,
            },
            mcp: { enabled: config.installCodexMcp, tools: config.codexMcpTools, projectRoot: config.codexMcpProjectRoot },
        },
        agy: {
            hooks: {
                enabled: config.installAgyHooks,
                basePreset: config.agyHookLevel,
                selectedHooks: config.agyHooksSelection?.selectedHooks ?? getHooksForLevel(config.agyHookLevel, 'agy'),
                isCustom: config.agyHooksSelection?.isCustom ?? false,
            },
        },
        genericHooks: { ...config.genericHookLevels },
        extraMcp: { enabled: config.installExtraMcp, targetIds: config.extraMcpTargetIds },
        backup: { claudeMd: config.backupClaudeMd, all: config.backupAll },
        plugin: (config.installPluginClaude || config.installPluginCodex)
            ? { enabled: true, claude: !!config.installPluginClaude, codex: !!config.installPluginCodex }
            : undefined,
    };
}
export function profileToStateValues(profile) {
    return {
        mode: profile.scope,
        enabledSteps: {
            components: profile.components.enabled,
            hooks: profile.claude.hooks.enabled,
            mcp: profile.claude.mcp.enabled,
            codexHooks: profile.codex.hooks.enabled,
            codexMcp: profile.codex.mcp.enabled,
            agyHooks: profile.agy.hooks.enabled,
            extraMcp: profile.extraMcp.enabled,
            statusline: profile.claude.statusline.enabled,
            backup: profile.backup.claudeMd || profile.backup.all,
            pluginClaude: profile.plugin?.claude ?? false,
            pluginCodex: profile.plugin?.codex ?? false,
        },
        selectedComponentIds: profile.components.selectedIds,
        claudeHooks: { basePreset: profile.claude.hooks.basePreset, selectedHooks: profile.claude.hooks.selectedHooks, isCustom: profile.claude.hooks.isCustom },
        mcpEnabled: profile.claude.mcp.enabled,
        mcpTools: profile.claude.mcp.tools,
        mcpProjectRoot: profile.claude.mcp.projectRoot,
        codexHooks: { basePreset: profile.codex.hooks.basePreset, selectedHooks: profile.codex.hooks.selectedHooks, isCustom: profile.codex.hooks.isCustom },
        codexMcpEnabled: profile.codex.mcp.enabled,
        codexMcpTools: profile.codex.mcp.tools,
        codexMcpProjectRoot: profile.codex.mcp.projectRoot,
        agyHooks: { basePreset: profile.agy.hooks.basePreset, selectedHooks: profile.agy.hooks.selectedHooks, isCustom: profile.agy.hooks.isCustom },
        genericHookLevels: { ...(profile.genericHooks ?? {}) },
        extraMcpTargetIds: profile.extraMcp.targetIds,
        installStatusline: profile.claude.statusline.enabled,
        statuslineTheme: profile.claude.statusline.theme,
        backupClaudeMd: profile.backup.claudeMd,
        backupAll: profile.backup.all,
    };
}
export function listProfiles() {
    ensureProfileDir();
    const files = readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
        const filePath = join(PROFILE_DIR, f);
        try {
            const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
            return {
                name: raw.name ?? f.replace('.json', ''),
                filePath,
                scope: raw.scope ?? 'unknown',
                createdAt: raw.createdAt ?? '',
            };
        }
        catch {
            return { name: f.replace('.json', ''), filePath, scope: 'unknown', createdAt: '' };
        }
    });
}
//# sourceMappingURL=install-profile.js.map