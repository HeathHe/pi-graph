import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { paths } from '../../config/paths.js';
import { C } from '../shared/index.js';
import { scanDisabledItems, restoreDisabledState, applyOverlaysPostInstall, addMcpServer, copyRecursive, injectDocFile, createBackup, uninstallManifest, } from '../../commands/install-backend.js';
import { createManifest, addFile, addDir, saveManifest, findManifest, recordClaudeHooks, recordClaudeMcp, } from '../../core/manifest.js';
import { installHooksByLevel } from '../../commands/hooks.js';
export function ExecutionView({ components, config, pkgRoot, version, onComplete, }) {
    const [status, setStatus] = useState('Scanning...');
    const [progress, setProgress] = useState('');
    const [elapsed, setElapsed] = useState(0);
    const [done, setDone] = useState(false);
    const [error, setError] = useState(null);
    // Elapsed timer
    useEffect(() => {
        const timer = setInterval(() => setElapsed((e) => e + 1), 1000);
        return () => clearInterval(timer);
    }, []);
    // Install orchestration
    useEffect(() => {
        let cancelled = false;
        async function run() {
            try {
                const targetBase = config.mode === 'global' ? homedir() : config.projectPath;
                const targetPath = config.mode === 'global' ? paths.home : config.projectPath;
                // 1. Scan disabled items
                if (cancelled)
                    return;
                setStatus('Scanning disabled items...');
                const disabledItems = scanDisabledItems(targetBase);
                // 2. Backup if requested
                if (config.doBackup) {
                    const existingManifest = findManifest(config.mode, targetPath);
                    if (existingManifest) {
                        if (cancelled)
                            return;
                        setStatus('Creating backup...');
                        createBackup(existingManifest);
                    }
                }
                // 3. Clean previous installation (full uninstall — files + hooks + mcp + statusline)
                const existingManifest = findManifest(config.mode, targetPath);
                if (existingManifest) {
                    if (cancelled)
                        return;
                    setStatus('Cleaning previous installation...');
                    uninstallManifest(existingManifest, { skipContentManaged: true });
                }
                // 4. Ensure home directory exists
                paths.ensure(paths.home);
                // 5. Create manifest (save early so interrupted installs are trackable)
                if (cancelled)
                    return;
                setStatus('Creating manifest...');
                const manifest = createManifest(config.mode, targetPath, {
                    hookLevel: config.hookLevel,
                    selectedComponentIds: config.selectedIds,
                });
                saveManifest(manifest);
                const totalStats = { files: 0, dirs: 0, skipped: 0 };
                const migrationWarnings = [];
                // 6. Copy components
                const selectedComponents = components.filter((c) => config.selectedIds.includes(c.def.id));
                for (let i = 0; i < selectedComponents.length; i++) {
                    if (cancelled)
                        return;
                    const comp = selectedComponents[i];
                    setStatus(`Installing ${comp.def.label}...`);
                    const beforeFiles = totalStats.files;
                    if (comp.def.build) {
                        const result = comp.def.build(join(pkgRoot, '.claude'), comp.targetDir);
                        totalStats.files += result.files;
                        trackBuildOutput(comp.targetDir, manifest);
                    }
                    else if (comp.def.inject) {
                        const result = injectDocFile(comp.sourceFull, comp.targetDir, totalStats, manifest, comp.def.section);
                        if (result.warning)
                            migrationWarnings.push(result.warning);
                    }
                    else {
                        copyRecursive(comp.sourceFull, comp.targetDir, totalStats, manifest, comp.def.fileFilter);
                    }
                    const delta = totalStats.files - beforeFiles;
                    setProgress(`(${delta} files)`);
                }
                // 7. Write version.json
                if (cancelled)
                    return;
                setStatus('Writing version marker...');
                const versionData = {
                    version,
                    installedAt: new Date().toISOString(),
                    installer: 'maestro',
                };
                const versionPath = join(paths.home, 'version.json');
                writeFileSync(versionPath, JSON.stringify(versionData, null, 2), 'utf-8');
                addFile(manifest, versionPath);
                totalStats.files++;
                // 8. Restore disabled state
                if (cancelled)
                    return;
                setStatus('Restoring disabled state...');
                const disabledRestored = restoreDisabledState(disabledItems, targetBase);
                // 9. Apply overlays
                if (cancelled)
                    return;
                setStatus('Applying overlays...');
                const overlaysApplied = applyOverlaysPostInstall(config.mode, targetBase);
                // 10. MCP registration
                let mcpRegistered = false;
                if (config.mcpEnabled && config.mcpTools.length > 0) {
                    if (cancelled)
                        return;
                    setStatus('Registering MCP server...');
                    const path = addMcpServer(config.mode, config.projectPath, config.mcpTools, config.mcpProjectRoot || undefined);
                    mcpRegistered = !!path;
                    if (path) {
                        recordClaudeMcp(manifest, { configPath: path, serverName: 'maestro-tools' });
                    }
                }
                // 11. Hook installation
                let hookResult = null;
                if (config.hookLevel !== 'none') {
                    if (cancelled)
                        return;
                    setStatus('Installing hooks...');
                    const hookRes = installHooksByLevel(config.hookLevel, { project: config.mode === 'project' });
                    hookResult = {
                        installedHooks: hookRes.installedHooks,
                        level: config.hookLevel,
                    };
                    recordClaudeHooks(manifest, {
                        settingsPath: hookRes.settingsPath,
                        installed: hookRes.installedHooks,
                        level: config.hookLevel,
                    });
                }
                // 12. Save manifest
                if (cancelled)
                    return;
                setStatus('Saving manifest...');
                const manifestPath = saveManifest(manifest);
                // Complete
                setDone(true);
                setStatus('Installation complete');
                setProgress('');
                onComplete({
                    totalStats,
                    manifestPath,
                    mcpRegistered,
                    hookResult,
                    disabledRestored,
                    overlaysApplied,
                });
            }
            catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            }
        }
        run();
        return () => {
            cancelled = true;
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const timeStr = minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
    if (error) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { color: C.error, bold: true, children: "Installation failed" }), _jsx(Text, { color: C.error, children: error })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Box, { children: [done ? (_jsxs(Text, { color: C.success, bold: true, children: ['  ', "Done"] })) : (_jsxs(Box, { children: [_jsx(Text, { color: C.primary, children: _jsx(Spinner, { type: "dots" }) }), _jsxs(Text, { children: [" ", status] })] })), progress && _jsxs(Text, { children: [" ", progress] })] }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["Elapsed: ", timeStr] }) })] }));
}
function trackBuildOutput(dir, manifest) {
    if (!existsSync(dir))
        return;
    const st = statSync(dir);
    if (st.isFile()) {
        addFile(manifest, dir);
        return;
    }
    addDir(manifest, dir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            trackBuildOutput(fullPath, manifest);
        }
        else {
            addFile(manifest, fullPath);
        }
    }
}
//# sourceMappingURL=ExecutionView.js.map