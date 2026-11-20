// ---------------------------------------------------------------------------
// Skill scanner — discovers commands + skills across all platforms.
//
// Sources (project overrides global by `(platform, name)`):
//   - <cwd>/.claude/commands/*.md           type: command, scope: project, platform: claude
//   - ~/.claude/commands/*.md               type: command, scope: global,  platform: claude
//   - <cwd>/.claude/skills/*/SKILL.md       type: skill,   scope: project, platform: claude
//   - ~/.claude/skills/*/SKILL.md           type: skill,   scope: global,  platform: claude
//   - <cwd>/.codex/skills/*/SKILL.md        type: skill,   scope: project, platform: codex
//   - ~/.codex/skills/*/SKILL.md            type: skill,   scope: global,  platform: codex
//   - <cwd>/.agents/skills/*/SKILL.md       type: skill,   scope: project, platform: agent
//   - ~/.agents/skills/*/SKILL.md           type: skill,   scope: global,  platform: agent
//   - <cwd>/.agy/skills/*/SKILL.md          type: skill,   scope: project, platform: agy
//   - ~/.agy/skills/*/SKILL.md              type: skill,   scope: global,  platform: agy
//   - <pi-maestro-flow>/<pi.skills>/*/SKILL.md
//     discovered from the npm package manifest; project package overrides runtime package
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillManifest } from './skill-resolver.js';
function collectCommandFiles(dir) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.md'))
            continue;
        const full = join(dir, name);
        try {
            if (statSync(full).isFile())
                out.push(full);
        }
        catch { /* ignore */ }
    }
    return out;
}
function collectSkillFiles(dir) {
    if (!existsSync(dir))
        return [];
    const out = [];
    for (const name of readdirSync(dir)) {
        const skillFile = join(dir, name, 'SKILL.md');
        try {
            if (existsSync(skillFile) && statSync(skillFile).isFile())
                out.push(skillFile);
        }
        catch { /* ignore */ }
    }
    return out;
}
function scanOne(filePath, type, scope, platform, fallbackName) {
    try {
        const m = parseSkillManifest(filePath);
        const fmName = (m.frontmatter.name ?? '').toString().trim();
        const description = (m.frontmatter.description ?? '').toString();
        const argumentHint = (m.frontmatter['argument-hint'] ?? '').toString();
        return {
            type,
            scope,
            platform,
            name: fmName || fallbackName,
            filePath,
            description,
            argumentHint,
            requiredCount: m.requiredPaths.length,
            deferredCount: m.deferredPaths.length,
            missingRequired: m.missingRequired,
        };
    }
    catch {
        return {
            type, scope, platform, name: fallbackName, filePath,
            description: '(parse error)', argumentHint: '',
            requiredCount: 0, deferredCount: 0, missingRequired: [],
        };
    }
}
/**
 * Locate Pi skills through the owning npm package.
 *
 * npm may keep maestro-flow under pi-maestro-flow/node_modules or dedupe both
 * packages into the same node_modules directory, so inspect both ancestors and
 * sibling package slots. The package manifest's `pi.skills` field is the only
 * directory authority.
 */
export function discoverPiSkillSources(workflowRoot = resolve(process.cwd()), runtimeModulePath = fileURLToPath(import.meta.url), advertisedPackageRoot = process.env.MAESTRO_PI_PACKAGE_ROOT) {
    const discovered = new Map();
    const addPackage = (packageRoot, scope) => {
        for (const dir of readPiSkillDirs(packageRoot)) {
            const key = process.platform === 'win32' ? dir.toLowerCase() : dir;
            const existing = discovered.get(key);
            if (!existing || (existing.scope === 'global' && scope === 'project')) {
                discovered.set(key, { dir, scope });
            }
        }
    };
    if (advertisedPackageRoot?.trim()) {
        addPackage(resolve(advertisedPackageRoot), 'global');
    }
    addPackage(workflowRoot, 'project');
    addPackage(join(workflowRoot, 'node_modules', 'pi-maestro-flow'), 'project');
    let cursor = dirname(resolve(runtimeModulePath));
    while (true) {
        addPackage(cursor, 'global');
        addPackage(join(cursor, 'node_modules', 'pi-maestro-flow'), 'global');
        const parent = dirname(cursor);
        if (parent === cursor)
            break;
        cursor = parent;
    }
    return Array.from(discovered.values()).sort((a, b) => {
        if (a.scope !== b.scope)
            return a.scope === 'global' ? -1 : 1;
        return a.dir.localeCompare(b.dir);
    });
}
export function diagnosePiSkillSources(workflowRoot = resolve(process.cwd()), runtimeModulePath = fileURLToPath(import.meta.url)) {
    return discoverPiSkillSources(workflowRoot, runtimeModulePath)
        .filter(source => !existsSync(source.dir))
        .map(source => ({ ...source, code: 'PI_SKILL_DIR_MISSING' }));
}
function readPiSkillDirs(packageRoot) {
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath))
        return [];
    try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        if (manifest.name !== 'pi-maestro-flow' || !Array.isArray(manifest.pi?.skills))
            return [];
        return manifest.pi.skills
            .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
            .map(entry => resolve(packageRoot, entry))
            .filter(dir => {
            const fromRoot = relative(packageRoot, dir);
            return fromRoot === ''
                || (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`));
        });
    }
    catch {
        return [];
    }
}
export function scanAllSkills(workflowRoot = resolve(process.cwd()), opts = {}) {
    const home = homedir();
    const commandName = (p) => p.split(/[\\/]/).pop().replace(/\.md$/, '');
    const skillName = (p) => p.split(/[\\/]/).slice(-2, -1)[0];
    const allSources = [
        // Claude platform
        {
            files: collectCommandFiles(join(home, '.claude', 'commands')),
            type: 'command', scope: 'global', platform: 'claude', nameFn: commandName,
        },
        {
            files: collectCommandFiles(join(workflowRoot, '.claude', 'commands')),
            type: 'command', scope: 'project', platform: 'claude', nameFn: commandName,
        },
        {
            files: collectSkillFiles(join(home, '.claude', 'skills')),
            type: 'skill', scope: 'global', platform: 'claude', nameFn: skillName,
        },
        {
            files: collectSkillFiles(join(workflowRoot, '.claude', 'skills')),
            type: 'skill', scope: 'project', platform: 'claude', nameFn: skillName,
        },
        // Codex platform
        {
            files: collectSkillFiles(join(home, '.codex', 'skills')),
            type: 'skill', scope: 'global', platform: 'codex', nameFn: skillName,
        },
        {
            files: collectSkillFiles(join(workflowRoot, '.codex', 'skills')),
            type: 'skill', scope: 'project', platform: 'codex', nameFn: skillName,
        },
        // Agent Skills open-standard (.agents/)
        {
            files: collectSkillFiles(join(home, '.agents', 'skills')),
            type: 'skill', scope: 'global', platform: 'agent', nameFn: skillName,
        },
        {
            files: collectSkillFiles(join(workflowRoot, '.agents', 'skills')),
            type: 'skill', scope: 'project', platform: 'agent', nameFn: skillName,
        },
        // Agy / Antigravity (.agy/)
        {
            files: collectSkillFiles(join(home, '.agy', 'skills')),
            type: 'skill', scope: 'global', platform: 'agy', nameFn: skillName,
        },
        {
            files: collectSkillFiles(join(workflowRoot, '.agy', 'skills')),
            type: 'skill', scope: 'project', platform: 'agy', nameFn: skillName,
        },
        // Pi Agent (pi-maestro-flow npm package)
        ...discoverPiSkillSources(workflowRoot).map(source => ({
            files: collectSkillFiles(source.dir),
            type: 'skill',
            scope: source.scope,
            platform: 'pi',
            nameFn: skillName,
        })),
    ];
    const sources = opts.platform
        ? allSources.filter(s => s.platform === opts.platform)
        : allSources;
    // Project overrides global per (platform, type, name).
    const merged = new Map();
    for (const src of sources) {
        for (const file of src.files) {
            const entry = scanOne(file, src.type, src.scope, src.platform, src.nameFn(file));
            const key = `${entry.platform}::${entry.type}::${entry.name}`;
            const existing = merged.get(key);
            if (!existing || (existing.scope === 'global' && entry.scope === 'project')) {
                merged.set(key, entry);
            }
        }
    }
    return Array.from(merged.values()).sort((a, b) => {
        if (a.platform !== b.platform)
            return a.platform.localeCompare(b.platform);
        if (a.type !== b.type)
            return a.type.localeCompare(b.type);
        if (a.scope !== b.scope)
            return a.scope.localeCompare(b.scope);
        return a.name.localeCompare(b.name);
    });
}
/** Look up a single skill/command by name. Returns null if not found. */
export function findSkill(name, type, platform) {
    const all = scanAllSkills(undefined, platform ? { platform } : {});
    return all.find(s => s.name === name && (!type || s.type === type)) ?? null;
}
//# sourceMappingURL=skill-scanner.js.map