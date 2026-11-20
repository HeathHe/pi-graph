import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import React, { useMemo } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import Gradient from 'ink-gradient';
import BigText from 'ink-big-text';
import { C, SYM, SP, Breadcrumb, SectionHeader, wrapCursor, KeyHints } from '../shared/index.js';
import { GroupedHub } from './GroupedHub.js';
import { ComponentGrid } from './ComponentGrid.js';
import { HooksConfig } from './HooksConfig.js';
import { McpConfig } from './McpConfig.js';
import { ExtraMcpConfig } from './ExtraMcpConfig.js';
import { StatuslineConfig } from './StatuslineConfig.js';
import { BackupConfig } from './BackupConfig.js';
import { EmbeddingPanel } from './EmbeddingPanel.js';
import { EntryCommandsConfig } from './EntryCommandsConfig.js';
import { InstallConfirm } from './InstallConfirm.js';
import { InstallExecution } from './InstallExecution.js';
import { InstallResult } from './InstallResult.js';
import { useInstallFlowState } from './useInstallFlowState.js';
import { t } from '../../i18n/index.js';
const CONFIG_STEPS = [
    'components_config', 'hooks_config', 'mcp_config',
    'codex_hooks_config', 'codex_mcp_config',
    'agy_hooks_config', 'extra_mcp_config',
    'statusline_config', 'backup_config', 'embedding_config',
    'entry_commands_config',
];
export function InstallFlow({ pkgRoot, version, initialStep, initialMode, initialStepIds, initialProjectPath }) {
    const { exit } = useApp();
    const s = useInstallFlowState({ pkgRoot, initialStep, initialMode, initialStepIds, initialProjectPath });
    // Global input for config steps
    useInput((_input, key) => {
        if (s.step === 'executing' || s.step === 'complete')
            return;
        if (s.step === 'platforms')
            return;
        if (s.step === 'components_config') {
            if (key.escape || key.leftArrow)
                s.setStep(s.isSubcommand ? 'confirm' : 'hub');
            return;
        }
        if (CONFIG_STEPS.includes(s.step)) {
            if (key.return)
                s.returnFromConfig();
            else if (key.escape || key.leftArrow)
                s.setStep(s.isSubcommand ? 'confirm' : 'hub');
            return;
        }
    });
    // Breadcrumb path
    const breadcrumbPath = useMemo(() => {
        const hub = t.install.stepMenu;
        switch (s.step) {
            case 'components_config': return [hub, t.install.groupCore, t.install.hubLabelComponents];
            case 'hooks_config': return [hub, t.install.groupHooks, 'Claude Hooks'];
            case 'mcp_config': return [hub, t.install.groupMcp, 'Claude MCP'];
            case 'statusline_config': return [hub, t.install.groupAppearance, t.install.hubLabelStatusline];
            case 'codex_hooks_config': return [hub, t.install.groupHooks, t.install.hubLabelCodexHooks];
            case 'codex_mcp_config': return [hub, t.install.groupMcp, t.install.hubLabelCodexMcp];
            case 'agy_hooks_config': return [hub, t.install.groupHooks, t.install.hubLabelAgyHooks];
            case 'extra_mcp_config': return [hub, t.install.groupMcp, t.install.hubLabelExtraMcp];
            case 'backup_config': return [hub, t.install.groupCore, t.install.hubLabelBackup];
            case 'embedding_config': return [hub, t.install.groupEmbedding, 'Embedding Model'];
            case 'entry_commands_config': return [hub, t.install.groupEntryCommands, 'Entry Commands'];
            default: return null;
        }
    }, [s.step]);
    // Progress steps
    const progressSteps = s.isSubcommand
        ? [
            { key: s.step.replace('_config', ''), label: s.step.replace('_config', '').charAt(0).toUpperCase() + s.step.replace('_config', '').slice(1) },
            { key: 'confirm', label: t.install.stepConfirm },
            { key: 'executing', label: t.install.stepInstall },
            { key: 'complete', label: t.install.stepDone },
        ]
        : [
            { key: 'platforms', label: t.install.stepPlatforms ?? 'Platforms' },
            { key: 'hub', label: t.install.stepMenu },
            { key: 'confirm', label: t.install.stepConfirm },
            { key: 'executing', label: t.install.stepInstall },
            { key: 'complete', label: t.install.stepDone },
        ];
    const progressKey = CONFIG_STEPS.includes(s.step)
        ? (s.isSubcommand ? s.step.replace('_config', '') : 'hub')
        : s.step;
    const stepIndex = progressSteps.findIndex((ps) => ps.key === progressKey);
    return (_jsxs(Box, { flexDirection: "column", width: "100%", children: [_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Box, { children: _jsx(Gradient, { name: "fruit", children: _jsx(BigText, { text: "MAESTRO", font: "slick" }) }) }), _jsxs(Box, { marginTop: -1, marginLeft: 2, gap: 2, children: [_jsx(Text, { dimColor: true, children: "flow" }), _jsx(Text, { dimColor: true, children: "\u00B7" }), _jsx(Text, { dimColor: true, children: t.install.headerVersion.replace('{version}', version) })] }), _jsx(Box, { marginTop: 1, gap: 1, children: progressSteps.map((ps, i) => (_jsxs(Text, { bold: ps.key === progressKey, color: i < stepIndex ? C.success : ps.key === progressKey ? C.primary : C.neutral, children: [i < stepIndex ? SYM.stepDone : ps.key === progressKey ? SYM.stepActive : SYM.stepPending, " ", ps.label] }, ps.key))) })] }), _jsxs(Box, { flexGrow: 1, flexDirection: "column", paddingX: 1, marginTop: 1, children: [breadcrumbPath && (_jsx(Box, { marginBottom: 1, children: _jsx(Breadcrumb, { path: breadcrumbPath }) })), s.step === 'platforms' && (_jsx(PlatformSelector, { selectedPlatforms: s.selectedPlatforms, onToggle: s.togglePlatform, mode: s.mode, onModeChange: s.setMode, onNext: () => s.setStep('hub'), onExit: () => exit(), codexDedupeAgents: s.codexDedupeAgents, onDedupeChange: s.setCodexDedupeAgents, pluginClaude: s.enabledSteps.pluginClaude, pluginCodex: s.enabledSteps.pluginCodex, onPluginToggle: (id) => s.toggleStep(id) })), s.step === 'hub' && (_jsxs(_Fragment, { children: [_jsx(GroupedHub, { groups: s.hubGroups, mode: s.mode, onModeChange: s.setMode, onToggle: s.toggleStep, onEnter: s.enterConfig, onInstall: () => s.setStep('confirm'), onExport: s.handleExport, onImport: s.handleImport, onExit: () => s.isSubcommand ? exit() : s.setStep('platforms'), lastInstallDate: s.lastManifest?.installedAt?.split('T')[0] }), s.profileMessage && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: s.profileMessage.startsWith('✓') ? C.success : s.profileMessage.startsWith('✗') ? C.error : C.warning, children: s.profileMessage }) }))] })), s.step === 'components_config' && (_jsx(ComponentGrid, { components: s.scannedComponents, selectedIds: s.selectedComponentIds, onSelectionChange: s.setSelectedComponentIds, onDone: s.returnFromConfig })), s.step === 'hooks_config' && (_jsx(HooksConfig, { selection: s.claudeHooksSelection, onSelectionChange: s.setClaudeHooksSelection, tool: "claude" })), s.step === 'mcp_config' && (_jsx(McpConfig, { enabled: s.mcpEnabled, tools: s.mcpTools, projectRoot: s.mcpProjectRoot, mode: s.mode, onEnableChange: s.setMcpEnabled, onToolsChange: s.setMcpTools, onRootChange: s.setMcpProjectRoot })), s.step === 'codex_hooks_config' && (_jsx(HooksConfig, { selection: s.codexHooksSelection, onSelectionChange: s.setCodexHooksSelection, tool: "codex", title: "Codex Hooks", descriptions: t.install.codexHooksLevelDescriptions })), s.step === 'codex_mcp_config' && (_jsx(McpConfig, { enabled: s.codexMcpEnabled, tools: s.codexMcpTools, projectRoot: s.codexMcpProjectRoot, mode: s.mode, onEnableChange: s.setCodexMcpEnabled, onToolsChange: s.setCodexMcpTools, onRootChange: s.setCodexMcpProjectRoot })), s.step === 'agy_hooks_config' && (_jsx(HooksConfig, { selection: s.agyHooksSelection, onSelectionChange: s.setAgyHooksSelection, tool: "agy", title: "Agy (Antigravity) Hooks", descriptions: t.install.agyHooksLevelDescriptions })), s.step === 'extra_mcp_config' && (_jsx(ExtraMcpConfig, { mode: s.mode, selectedIds: s.extraMcpTargetIds, onSelectionChange: s.setExtraMcpTargetIds, onDone: s.returnFromConfig, onBack: () => s.setStep(s.isSubcommand ? 'confirm' : 'hub') })), s.step === 'statusline_config' && (_jsx(StatuslineConfig, { enabled: s.installStatusline, theme: s.statuslineTheme, detected: s.statuslineDetected, onToggle: s.setInstallStatusline, onThemeChange: s.setStatuslineTheme })), s.step === 'backup_config' && (_jsx(BackupConfig, { backupClaudeMd: s.backupClaudeMd, backupAll: s.backupAll, existingFileCount: s.existingFileCount, onClaudeMdChange: s.setBackupClaudeMd, onAllChange: s.setBackupAll })), s.step === 'embedding_config' && (_jsx(EmbeddingPanel, { onDone: s.returnFromConfig })), s.step === 'entry_commands_config' && (_jsx(EntryCommandsConfig, { eligibleSteps: s.eligibleEntrySteps, selectedSteps: s.selectedEntrySteps, onSelectionChange: s.setSelectedEntrySteps, onDone: s.returnFromConfig })), s.step === 'confirm' && (_jsx(InstallConfirm, { config: s.flowConfig, onConfirm: () => s.setStep('executing'), onBack: () => s.setStep(s.isSubcommand ? (s.resolvedInitialStep ?? 'hub') : 'hub') })), s.step === 'executing' && (_jsx(InstallExecution, { config: s.flowConfig, pkgRoot: pkgRoot, version: version, onComplete: (r) => { s.setResult(r); s.setStep('complete'); } })), s.step === 'complete' && s.result && (_jsx(InstallResult, { result: s.result }))] })] }));
}
// ---------------------------------------------------------------------------
// PlatformSelector — first step: choose which platforms to install
// ---------------------------------------------------------------------------
const PLATFORM_DEFS = [
    { id: 'claude', label: 'Claude Code', desc: 'Commands, skills, agents, hooks, MCP' },
    { id: 'codex', label: 'Codex', desc: 'Agents, skills, hooks, MCP' },
    { id: 'cursor', label: 'Cursor', desc: 'Skills, agents → .cursor/' },
    { id: 'agy', label: 'Agy (Gemini CLI)', desc: 'Skills, agents, hooks → .gemini/' },
    { id: 'copilot', label: 'GitHub Copilot', desc: 'Skills, agents → .github/' },
    { id: 'kiro', label: 'Kiro', desc: 'Skills, agents → .kiro/' },
    { id: 'opencode', label: 'OpenCode', desc: 'Skills, agents → .opencode/' },
    { id: 'kilo', label: 'Kilo Code', desc: 'Skills, agents → .kilocode/' },
    { id: 'devin', label: 'Devin', desc: 'Skills, agents → .devin/' },
    { id: 'qoder', label: 'Qoder / Qoder CN', desc: 'Skills, agents → .qoder/' },
    { id: 'codebuddy', label: 'CodeBuddy', desc: 'Skills, agents → .codebuddy/' },
    { id: 'droid', label: 'Droid', desc: 'Skills, agents → .factory/' },
    { id: 'trae', label: 'Trae / Trae CN', desc: 'Skills, agents → .trae/' },
    { id: 'roo', label: 'Roo Code', desc: 'Skills, agents → .roo/' },
    { id: 'aider-desk', label: 'AiderDesk', desc: 'Skills, agents → .aider-desk/' },
    { id: 'amp', label: 'Amp', desc: 'Skills, agents → .amp/' },
    { id: 'antigravity', label: 'Antigravity', desc: 'Skills, agents → .antigravity/' },
    { id: 'antigravity-cli', label: 'Antigravity CLI', desc: 'Skills, agents → .antigravity-cli/' },
    { id: 'astrbot', label: 'AstrBot', desc: 'Skills, agents → .astrbot/' },
    { id: 'autohand-code', label: 'Autohand Code CLI', desc: 'Skills, agents → .autohand/' },
    { id: 'augment', label: 'Augment', desc: 'Skills, agents → .augment/' },
    { id: 'bob', label: 'IBM Bob', desc: 'Skills, agents → .bob/' },
    { id: 'cline', label: 'Cline', desc: 'Skills, agents → .cline/' },
    { id: 'codearts-agent', label: 'CodeArts Agent', desc: 'Skills, agents → .codeartsdoer/' },
    { id: 'codemaker', label: 'Codemaker', desc: 'Skills, agents → .codemaker/' },
    { id: 'codestudio', label: 'Code Studio', desc: 'Skills, agents → .codestudio/' },
    { id: 'command-code', label: 'Command Code', desc: 'Skills, agents → .commandcode/' },
    { id: 'continue', label: 'Continue', desc: 'Skills, agents → .continue/' },
    { id: 'cortex', label: 'Cortex Code', desc: 'Skills, agents → .cortex/' },
    { id: 'crush', label: 'Crush', desc: 'Skills, agents → .crush/' },
    { id: 'deepagents', label: 'Deep Agents', desc: 'Skills, agents → .deepagents/' },
    { id: 'dexto', label: 'Dexto', desc: 'Skills, agents → .dexto/' },
    { id: 'eve', label: 'Eve', desc: 'Skills, agents → agent/' },
    { id: 'firebender', label: 'Firebender', desc: 'Skills, agents → .firebender/' },
    { id: 'forgecode', label: 'ForgeCode', desc: 'Skills, agents → .forge/' },
    { id: 'goose', label: 'Goose', desc: 'Skills, agents → .goose/' },
    { id: 'grok', label: 'Grok Build', desc: 'Skills, agents → .grok/' },
    { id: 'hermes-agent', label: 'Hermes Agent', desc: 'Skills, agents → .hermes/' },
    { id: 'inference-sh', label: 'inference.sh', desc: 'Skills, agents → .inferencesh/' },
    { id: 'jazz', label: 'Jazz', desc: 'Skills, agents → .jazz/' },
    { id: 'junie', label: 'Junie', desc: 'Skills, agents → .junie/' },
    { id: 'iflow-cli', label: 'iFlow CLI', desc: 'Skills, agents → .iflow/' },
    { id: 'kimi-code-cli', label: 'Kimi Code CLI', desc: 'Skills, agents → .kimi-code/' },
    { id: 'kode', label: 'Kode', desc: 'Skills, agents → .kode/' },
    { id: 'lingma', label: 'Lingma', desc: 'Skills, agents → .lingma/' },
    { id: 'loaf', label: 'Loaf', desc: 'Skills, agents → .loaf/' },
    { id: 'mcpjam', label: 'MCPJam', desc: 'Skills, agents → .mcpjam/' },
    { id: 'mistral-vibe', label: 'Mistral Vibe', desc: 'Skills, agents → .vibe/' },
    { id: 'moxby', label: 'Moxby', desc: 'Skills, agents → .moxby/' },
    { id: 'mux', label: 'Mux', desc: 'Skills, agents → .mux/' },
    { id: 'openhands', label: 'OpenHands', desc: 'Skills, agents → .openhands/' },
    { id: 'ona', label: 'Ona', desc: 'Skills, agents → .ona/' },
    { id: 'qwen-code', label: 'Qwen Code', desc: 'Skills, agents → .qwen/' },
    { id: 'replit', label: 'Replit', desc: 'Skills, agents → .replit/' },
    { id: 'reasonix', label: 'Reasonix', desc: 'Skills, agents → .reasonix/' },
    { id: 'rovodev', label: 'Rovo Dev', desc: 'Skills, agents → .rovodev/' },
    { id: 'tabnine-cli', label: 'Tabnine CLI', desc: 'Skills, agents → .tabnine/' },
    { id: 'terramind', label: 'Terramind', desc: 'Skills, agents → .terramind/' },
    { id: 'tinycloud', label: 'Tinycloud', desc: 'Skills, agents → .tinycloud/' },
    { id: 'warp', label: 'Warp', desc: 'Skills, agents → .warp/' },
    { id: 'windsurf', label: 'Windsurf', desc: 'Skills, agents → .windsurf/' },
    { id: 'zed', label: 'Zed', desc: 'Skills, agents → .zed/' },
    { id: 'zencoder', label: 'Zencoder / Zenflow', desc: 'Skills, agents → .zencoder/' },
    { id: 'neovate', label: 'Neovate', desc: 'Skills, agents → .neovate/' },
    { id: 'pochi', label: 'Pochi', desc: 'Skills, agents → .pochi/' },
    { id: 'promptscript', label: 'PromptScript', desc: 'Skills, agents → .promptscript/' },
    { id: 'adal', label: 'AdaL', desc: 'Skills, agents → .adal/' },
    { id: 'agents-standard', label: 'Open Standard', desc: '.agents/ format (portable)' },
];
function PlatformSelector({ selectedPlatforms, onToggle, mode, onModeChange, onNext, onExit, codexDedupeAgents, onDedupeChange, pluginClaude, pluginCodex, onPluginToggle, }) {
    const showDedupe = selectedPlatforms.has('codex') && selectedPlatforms.has('agents-standard');
    const PAGE_SIZE = 10;
    const [page, setPage] = React.useState(0);
    const pageCount = Math.ceil(PLATFORM_DEFS.length / PAGE_SIZE);
    const rows = React.useMemo(() => {
        const r = [];
        const startIdx = page * PAGE_SIZE;
        const endIdx = Math.min(startIdx + PAGE_SIZE, PLATFORM_DEFS.length);
        let localPlatIdx = 0;
        for (let i = startIdx; i < endIdx; i++) {
            const plat = PLATFORM_DEFS[i];
            r.push({ type: 'platform', id: plat.id, platIdx: i, localPlatIdx });
            localPlatIdx++;
            if (plat.id === 'claude' && selectedPlatforms.has('claude')) {
                r.push({ type: 'plugin', id: 'pluginClaude' });
            }
            if (plat.id === 'codex' && selectedPlatforms.has('codex')) {
                r.push({ type: 'plugin', id: 'pluginCodex' });
            }
        }
        if (showDedupe && endIdx === PLATFORM_DEFS.length) {
            r.push({ type: 'dedupe', id: 'dedupe' });
        }
        return r;
    }, [selectedPlatforms, showDedupe, page]);
    const [cursor, setCursor] = React.useState(0);
    const safeCursor = Math.min(cursor, rows.length - 1);
    const handlePageChange = (newPage) => {
        setPage(newPage);
        setCursor(0);
    };
    useInput((input, key) => {
        if (key.upArrow)
            setCursor(i => wrapCursor(Math.min(i, rows.length - 1), -1, rows.length));
        else if (key.downArrow)
            setCursor(i => wrapCursor(Math.min(i, rows.length - 1), 1, rows.length));
        else if (key.leftArrow || input === 'h' || input === 'H' || input === '[') {
            handlePageChange((page - 1 + pageCount) % pageCount);
        }
        else if (key.rightArrow || input === 'l' || input === 'L' || input === ']') {
            handlePageChange((page + 1) % pageCount);
        }
        else if (input === ' ') {
            const row = rows[safeCursor];
            if (!row)
                return;
            if (row.type === 'platform')
                onToggle(row.id);
            else if (row.type === 'plugin')
                onPluginToggle(row.id);
            else if (row.type === 'dedupe')
                onDedupeChange(!codexDedupeAgents);
        }
        else if (key.return)
            onNext();
        else if (key.escape)
            onExit();
        else if (input === 'g' || input === 'G')
            onModeChange('global');
        else if (input === 'p' || input === 'P')
            onModeChange('project');
        else {
            const n = parseInt(input, 10);
            if (n >= 1 && n <= 9) {
                const targetRow = rows.find(r => r.type === 'platform' && r.localPlatIdx === n - 1);
                if (targetRow) {
                    onToggle(targetRow.id);
                }
            }
        }
    });
    const isPlugin = (id) => id === 'pluginClaude' ? pluginClaude : pluginCodex;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.hubScope }), _jsxs(Text, { color: mode === 'global' ? C.success : C.neutral, bold: mode === 'global', children: [mode === 'global' ? SYM.radioOn : SYM.radioOff, " ", t.install.hubGlobal] }), _jsxs(Text, { color: mode === 'project' ? C.success : C.neutral, bold: mode === 'project', children: [mode === 'project' ? SYM.radioOn : SYM.radioOff, " ", t.install.hubProject] }), _jsx(Text, { dimColor: true, children: "[g/p]" })] }), _jsx(SectionHeader, { title: t.install.groupPlatforms ?? 'Platforms' }), _jsx(Box, { flexDirection: "column", marginTop: SP.sectionGap, children: rows.map((row, idx) => {
                    const hl = idx === safeCursor;
                    if (row.type === 'platform') {
                        const plat = PLATFORM_DEFS[row.platIdx];
                        const sel = selectedPlatforms.has(plat.id);
                        return (_jsxs(Box, { children: [_jsx(Text, { color: hl ? C.primary : C.neutral, children: row.localPlatIdx < 9 ? `[${row.localPlatIdx + 1}] ` : '    ' }), _jsxs(Text, { color: sel ? (hl ? C.successBright : C.success) : C.neutral, children: [sel ? SYM.checkOn : SYM.checkOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: plat.label.padEnd(22) }), _jsx(Text, { color: C.neutral, children: plat.desc })] }, row.id));
                    }
                    if (row.type === 'plugin') {
                        const plugin = isPlugin(row.id);
                        return (_jsxs(Box, { children: [_jsx(Text, { color: hl ? C.primary : C.neutral, children: '      ' }), _jsxs(Text, { color: !plugin ? (hl ? C.successBright : C.success) : C.neutral, children: [!plugin ? SYM.radioOn : SYM.radioOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, children: "Copy files  " }), _jsxs(Text, { color: plugin ? (hl ? C.successBright : C.success) : C.neutral, children: [plugin ? SYM.radioOn : SYM.radioOff, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, children: "Native plugin" })] }, row.id));
                    }
                    // dedupe
                    return (_jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: hl ? C.primary : C.neutral, children: "    " }), _jsxs(Text, { color: codexDedupeAgents ? (hl ? C.successBright : C.success) : C.neutral, children: [codexDedupeAgents ? SYM.checkOn : SYM.checkOff, ' '] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: 'Codex: disable .agents/ skills'.padEnd(22) }), _jsx(Text, { color: C.neutral, children: "avoid duplicate skill discovery" })] }, row.id));
                }) }), _jsxs(Box, { marginTop: 1, gap: 2, children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Page " }), _jsx(Text, { bold: true, color: C.primary, children: page + 1 }), _jsxs(Text, { dimColor: true, children: [" / ", pageCount, " "] }), _jsx(Text, { dimColor: true, children: "[" }), Array.from({ length: pageCount }).map((_, i) => (_jsx(Text, { color: i === page ? C.successBright : C.neutral, bold: i === page, children: i === page ? '●' : '○' }, i))), _jsx(Text, { dimColor: true, children: "]" })] }), _jsx(Text, { dimColor: true, children: "(Use Left/Right or h/l to page)" })] }), _jsxs(Box, { marginTop: 1, children: [_jsx(Text, { color: C.warning, children: "\u26A0 " }), _jsx(Text, { color: C.warning, wrap: "wrap", children: t.install.piPluginReminder })] }), _jsx(KeyHints, { hints: `[Space/1-9] Toggle  [Up/Down] Navigate  [Left/Right] Page  [g/p] Scope  [Enter] Next  [Esc] Exit` })] }));
}
//# sourceMappingURL=InstallFlow.js.map