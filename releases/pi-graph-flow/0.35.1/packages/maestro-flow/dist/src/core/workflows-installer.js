import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config/paths.js';
import { COMPONENT_DEFS } from './component-defs.js';
import { addFile, createManifest, findManifest, saveManifest } from './manifest.js';
function copyDirectory(sourceDir, targetDir) {
    let files = 0;
    let dirs = 0;
    const installedFiles = [];
    if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
        dirs++;
    }
    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
        const source = join(sourceDir, entry.name);
        const target = join(targetDir, entry.name);
        if (entry.isDirectory()) {
            const nested = copyDirectory(source, target);
            files += nested.files;
            dirs += nested.dirs;
            installedFiles.push(...nested.installedFiles);
        }
        else if (entry.isFile()) {
            copyFileSync(source, target);
            files++;
            installedFiles.push(target);
        }
    }
    return { files, dirs, installedFiles };
}
export function installWorkflowsOnly(packageRoot, targetDir = paths.workflows) {
    const sourceDir = join(packageRoot, 'workflows');
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        throw new Error(`Maestro workflows directory not found: ${sourceDir}`);
    }
    const copied = copyDirectory(sourceDir, targetDir);
    return {
        sourceDir,
        targetDir,
        filesInstalled: copied.files,
        dirsCreated: copied.dirs,
        installedFiles: copied.installedFiles,
    };
}
export function installPrepareFiles(packageRoot, targetDir = paths.prepare) {
    const sourceDir = join(packageRoot, 'prepare');
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        return { sourceDir, targetDir, filesInstalled: 0, dirsCreated: 0, installedFiles: [] };
    }
    const copied = copyDirectory(sourceDir, targetDir);
    return { sourceDir, targetDir, filesInstalled: copied.files, dirsCreated: copied.dirs, installedFiles: copied.installedFiles };
}
export function installRefFiles(packageRoot, targetDir = paths.ref) {
    const sourceDir = join(packageRoot, 'ref');
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        return { sourceDir, targetDir, filesInstalled: 0, dirsCreated: 0, installedFiles: [] };
    }
    const copied = copyDirectory(sourceDir, targetDir);
    return { sourceDir, targetDir, filesInstalled: copied.files, dirsCreated: copied.dirs, installedFiles: copied.installedFiles };
}
function validateArchKbSource(sourceDir) {
    if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
        throw new Error(`Maestro arch-kb directory not found: ${sourceDir}`);
    }
    const indexPath = join(sourceDir, 'index.json');
    if (!existsSync(indexPath))
        throw new Error(`Maestro arch-kb index not found: ${indexPath}`);
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(indexPath, 'utf8'));
    }
    catch (error) {
        throw new Error(`Maestro arch-kb index is invalid: ${indexPath}`, { cause: error });
    }
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) {
        throw new Error(`Maestro arch-kb index has no entries: ${indexPath}`);
    }
    const missing = parsed.entries
        .filter((entry) => typeof entry.path !== 'string' || !existsSync(join(sourceDir, entry.path)))
        .map((entry) => typeof entry.path === 'string' ? entry.path : '<invalid path>');
    if (missing.length > 0) {
        throw new Error(`Maestro arch-kb source files are missing (${missing.length}): ${missing.slice(0, 3).join(', ')}`);
    }
}
export function installArchKb(packageRoot, targetDir = paths.archKb) {
    const sourceDir = join(packageRoot, 'resources', 'arch-kb');
    validateArchKbSource(sourceDir);
    const copied = copyDirectory(sourceDir, targetDir);
    return { sourceDir, targetDir, filesInstalled: copied.files, dirsCreated: copied.dirs, installedFiles: copied.installedFiles };
}
export function installAllStepContent(packageRoot) {
    const result = {
        workflows: installWorkflowsOnly(packageRoot),
        prepare: installPrepareFiles(packageRoot),
        ref: installRefFiles(packageRoot),
        archKb: installArchKb(packageRoot),
    };
    // This direct subcommand is intentionally overwrite-only. Record only the
    // source-relative files it just copied and merge them into prior ownership;
    // target-only files remain untouched and unowned.
    const prior = findManifest('global', paths.home);
    const selectedIds = new Set(prior?.selectedComponentIds ?? []);
    if (result.workflows.filesInstalled > 0)
        selectedIds.add('workflows');
    if (result.prepare.filesInstalled > 0)
        selectedIds.add('prepare');
    if (result.ref.filesInstalled > 0)
        selectedIds.add('ref');
    if (result.archKb.filesInstalled > 0)
        selectedIds.add('arch-kb');
    const manifest = createManifest('global', paths.home, {
        hookLevel: prior?.hookLevel,
        selectedComponentIds: Array.from(selectedIds),
        knownComponentIds: COMPONENT_DEFS.map((def) => def.id),
    });
    if (prior) {
        manifest.entries = prior.entries.map((entry) => ({ ...entry }));
        if (prior.disabledItems)
            manifest.disabledItems = [...prior.disabledItems];
        if (prior.hooks)
            manifest.hooks = JSON.parse(JSON.stringify(prior.hooks));
        if (prior.statusline)
            manifest.statusline = { ...prior.statusline };
        if (prior.mcp)
            manifest.mcp = JSON.parse(JSON.stringify(prior.mcp));
        if (prior.plugin)
            manifest.plugin = { ...prior.plugin };
    }
    for (const filePath of [
        ...result.workflows.installedFiles,
        ...result.prepare.installedFiles,
        ...result.ref.installedFiles,
        ...result.archKb.installedFiles,
    ]) {
        addFile(manifest, filePath);
    }
    saveManifest(manifest, { expectedPriorId: prior?.id ?? null });
    return result;
}
//# sourceMappingURL=workflows-installer.js.map