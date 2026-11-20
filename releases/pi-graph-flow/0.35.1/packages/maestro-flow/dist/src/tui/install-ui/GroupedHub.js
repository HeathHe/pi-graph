import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { GENERIC_HOOKS_PLATFORMS } from '../../commands/hooks.js';
import { EXTRA_MCP_TARGETS } from '../../commands/install-backend.js';
import { t } from '../../i18n/index.js';
import { C, SYM, SP, wrapCursor, parseNumberKey, KeyHints } from '../shared/index.js';
export function GroupedHub({ groups, mode, onModeChange, onToggle, onEnter, onInstall, onExport, onImport, onExit, lastInstallDate, }) {
    const flat = useMemo(() => {
        const entries = [];
        groups.forEach((g, gi) => {
            g.items.forEach((item, ii) => {
                entries.push({ type: 'item', groupIdx: gi, itemIdx: ii, item });
            });
        });
        return entries;
    }, [groups]);
    const totalRows = flat.length + 3; // items + Install + Export + Import
    const [cursor, setCursor] = useState(0);
    const groupStartIndices = useMemo(() => {
        const starts = [];
        let idx = 0;
        groups.forEach((g) => {
            starts.push(idx);
            idx += g.items.length;
        });
        return starts;
    }, [groups]);
    const jumpNextGroup = () => {
        const currentGroupIdx = cursor < flat.length
            ? flat[cursor].groupIdx
            : groups.length - 1;
        const nextGroupIdx = (currentGroupIdx + 1) % groups.length;
        setCursor(groupStartIndices[nextGroupIdx]);
    };
    useInput((input, key) => {
        if (key.upArrow) {
            setCursor((i) => wrapCursor(i, -1, totalRows));
        }
        else if (key.downArrow) {
            setCursor((i) => wrapCursor(i, 1, totalRows));
        }
        else if (key.tab) {
            jumpNextGroup();
        }
        else if (key.return) {
            if (cursor < flat.length) {
                onEnter(flat[cursor].item.id);
            }
            else if (cursor === flat.length) {
                onInstall();
            }
            else if (cursor === flat.length + 1) {
                onExport();
            }
            else if (cursor === flat.length + 2) {
                onImport();
            }
        }
        else if (input === ' ' && cursor < flat.length) {
            onToggle(flat[cursor].item.id);
        }
        else if (input === 'g' || input === 'G') {
            onModeChange('global');
        }
        else if (input === 'p' || input === 'P') {
            onModeChange('project');
        }
        else if (input === 'e' || input === 'E') {
            onExport();
        }
        else if (input === 'i' || input === 'I') {
            onImport();
        }
        else if (key.escape || key.leftArrow) {
            onExit();
        }
        else {
            const idx = parseNumberKey(input, flat.length);
            if (idx !== null) {
                onToggle(flat[idx].item.id);
            }
        }
    });
    const focusedItem = cursor < flat.length ? flat[cursor].item : null;
    // Pre-compute flat index for each entry to avoid mutable counter in render
    const flatIndexMap = useMemo(() => {
        const map = new Map();
        flat.forEach((entry, i) => map.set(`${entry.groupIdx}-${entry.itemIdx}`, i));
        return map;
    }, [flat]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.hubScope }), _jsxs(Text, { color: mode === 'global' ? C.success : C.neutral, bold: mode === 'global', children: [mode === 'global' ? SYM.radioOn : SYM.radioOff, " ", t.install.hubGlobal] }), _jsxs(Text, { color: mode === 'project' ? C.success : C.neutral, bold: mode === 'project', children: [mode === 'project' ? SYM.radioOn : SYM.radioOff, " ", t.install.hubProject] }), _jsx(Text, { dimColor: true, children: "[g/p]" }), lastInstallDate && (_jsxs(Text, { dimColor: true, children: ['·', " ", t.install.hubLastInstall.replace('{date}', lastInstallDate)] }))] }), _jsxs(Box, { marginTop: SP.sectionGap, children: [_jsxs(Box, { flexDirection: "column", width: 44, children: [groups.map((group, gi) => {
                                const groupItems = flat.filter((e) => e.groupIdx === gi);
                                return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: C.primary, children: ['─'.repeat(2), " ", group.title, " ", '─'.repeat(Math.max(0, 38 - group.title.length))] }), groupItems.map((entry) => {
                                            const idx = flatIndexMap.get(`${entry.groupIdx}-${entry.itemIdx}`) ?? 0;
                                            const hl = cursor === idx;
                                            const item = entry.item;
                                            return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: [hl ? SYM.cursor : ' ', " "] }), _jsx(Text, { color: item.enabled ? (hl ? C.successBright : C.success) : C.neutral, children: item.enabled ? SYM.checkOn : SYM.checkOff }), _jsx(Text, { children: " " }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: item.label.padEnd(18) }), _jsx(Text, { color: item.enabled ? C.neutral : C.neutral, children: item.enabled ? item.summary : '—' }), item.hasConfig && (_jsxs(Text, { color: hl ? C.primary : C.neutral, children: [" ", hl ? '→' : ' '] }))] }, item.id));
                                        }), _jsx(Text, { children: " " })] }, group.id));
                            }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: C.primary, children: '─'.repeat(40) }), _jsxs(Text, { color: cursor === flat.length ? C.primary : C.neutral, bold: cursor === flat.length, children: [cursor === flat.length ? SYM.cursor : ' ', " ", t.install.hubExecuteInstall] }), _jsxs(Text, { color: cursor === flat.length + 1 ? C.primary : C.neutral, bold: cursor === flat.length + 1, children: [cursor === flat.length + 1 ? SYM.cursor : ' ', " ", t.install.hubExportConfig, "  [e]"] }), _jsxs(Text, { color: cursor === flat.length + 2 ? C.primary : C.neutral, bold: cursor === flat.length + 2, children: [cursor === flat.length + 2 ? SYM.cursor : ' ', " ", t.install.hubImportConfig, "  [i]"] })] })] }), focusedItem?.detail && (_jsxs(Box, { flexDirection: "column", borderStyle: "single", borderColor: C.neutral, paddingX: 1, width: 38, marginLeft: 2, children: [_jsx(Text, { bold: true, color: C.primary, children: focusedItem.label }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { wrap: "wrap", children: focusedItem.detail }) })] }))] }), _jsx(KeyHints, { hints: t.install.hubKeyHints })] }));
}
// ---------------------------------------------------------------------------
// Helper to build grouped hub items from config state
// ---------------------------------------------------------------------------
export function buildGroupedHubItems(enabled, summaries) {
    const hookSummary = (level, selCount, totalCount, isCustom) => {
        if (isCustom && selCount != null && totalCount != null) {
            return `custom (${selCount}/${totalCount})`;
        }
        if (selCount != null && totalCount != null) {
            return `${level} (${selCount}/${totalCount})`;
        }
        return level;
    };
    const backupSummary = summaries.backupAll
        ? t.install.backupAllLabel
        : summaries.backupClaudeMd
            ? t.install.backupClaudeMdLabel
            : '—';
    const platforms = new Set(summaries.selectedPlatforms);
    const addons = new Set(summaries.selectedAddons);
    const addonItems = [
        {
            id: 'chinese',
            label: 'Chinese Response',
            enabled: summaries.chineseEnabled,
            summary: summaries.chineseEnabled ? 'all selected platforms' : '—',
        },
        ...summaries.addonDefs
            .filter(d => d.platform === 'shared' || platforms.has(d.platform))
            .map(d => ({
            id: d.id,
            label: d.label,
            enabled: addons.has(d.id),
            summary: d.description,
        })),
    ];
    const groups = [
        { id: 'addons', title: t.install.groupAddons ?? 'Options', items: addonItems },
    ];
    // --- Hooks (by type, conditional per platform) ---
    const hookItems = [];
    if (platforms.has('claude')) {
        hookItems.push({
            id: 'hooks',
            label: 'Claude Hooks',
            enabled: enabled.hooks,
            summary: hookSummary(summaries.hookLevel, summaries.hookSelectedCount, summaries.hookTotalCount, summaries.hookIsCustom),
            detail: t.install.hubDetailHooks.replace('{level}', summaries.hookLevel),
            hasConfig: true,
        });
    }
    if (platforms.has('codex')) {
        hookItems.push({
            id: 'codexHooks',
            label: t.install.hubLabelCodexHooks,
            enabled: enabled.codexHooks,
            summary: hookSummary(summaries.codexHookLevel, summaries.codexHookSelectedCount, summaries.codexHookTotalCount, summaries.codexHookIsCustom),
            detail: t.install.hubDetailCodexHooks,
            hasConfig: true,
        });
    }
    if (platforms.has('agy')) {
        hookItems.push({
            id: 'agyHooks',
            label: t.install.hubLabelAgyHooks,
            enabled: enabled.agyHooks,
            summary: hookSummary(summaries.agyHookLevel, summaries.agyHookSelectedCount, summaries.agyHookTotalCount, summaries.agyHookIsCustom),
            detail: t.install.hubDetailAgyHooks,
            hasConfig: true,
        });
    }
    for (const gp of GENERIC_HOOKS_PLATFORMS) {
        if (!platforms.has(gp.id))
            continue;
        const level = summaries.genericHookLevels[gp.id] ?? 'none';
        hookItems.push({
            id: `ghooks-${gp.id}`,
            label: `${gp.label} Hooks`,
            enabled: level !== 'none',
            summary: level,
        });
    }
    if (hookItems.length > 0) {
        groups.push({ id: 'hooks', title: t.install.groupHooks, items: hookItems });
    }
    // --- MCP Server (by type, conditional per platform) ---
    const mcpItems = [];
    if (platforms.has('claude')) {
        mcpItems.push({
            id: 'mcp',
            label: 'Claude MCP',
            enabled: enabled.mcp,
            summary: summaries.mcpEnabled ? t.install.hubTools.replace('{count}', String(summaries.mcpToolCount)) : '—',
            detail: t.install.hubDetailMcp,
            hasConfig: true,
        });
    }
    if (platforms.has('codex')) {
        mcpItems.push({
            id: 'codexMcp',
            label: 'Codex MCP',
            enabled: enabled.codexMcp,
            summary: summaries.codexMcpEnabled ? t.install.hubTools.replace('{count}', String(summaries.codexMcpToolCount)) : '—',
            detail: t.install.hubDetailCodexMcp,
            hasConfig: true,
        });
    }
    // Per-platform MCP targets — only show for selected platforms
    const extraTargetIds = new Set(summaries.extraMcpTargetIds);
    const platformToMcpTarget = new Map([
        ['cursor', 'cursor'], ['qoder', 'qoder'], ['kiro', 'kiro'],
        ['agy', 'gemini-cli'], ['copilot', 'vscode-copilot'],
        ['trae', 'trae'], ['roo', 'roo'],
    ]);
    for (const target of EXTRA_MCP_TARGETS) {
        let matchedPlatform;
        for (const [platId, targetId] of platformToMcpTarget) {
            if (targetId === target.id && platforms.has(platId)) {
                matchedPlatform = platId;
                break;
            }
        }
        if (!matchedPlatform)
            continue;
        const platLabel = target.label.split('(')[0].trim();
        mcpItems.push({
            id: `mcp-${target.id}`,
            label: `${platLabel} MCP`,
            enabled: extraTargetIds.has(target.id),
            summary: extraTargetIds.has(target.id) ? 'enabled' : '—',
        });
    }
    if (mcpItems.length > 0) {
        groups.push({ id: 'mcp', title: t.install.groupMcp, items: mcpItems });
    }
    // --- Appearance (conditional) ---
    if (platforms.has('claude')) {
        groups.push({
            id: 'appearance',
            title: t.install.groupAppearance,
            items: [{
                    id: 'statusline',
                    label: t.install.hubLabelStatusline,
                    enabled: enabled.statusline,
                    summary: summaries.statuslineDetected
                        ? t.install.statuslineDetected.replace('{cmd}', summaries.statuslineDetected)
                        : (summaries.statuslineTheme || 'notion'),
                    detail: t.install.hubDetailStatusline.replace('{theme}', summaries.statuslineTheme || 'notion'),
                    hasConfig: true,
                }],
        });
    }
    // --- Embedding (always visible) ---
    groups.push({
        id: 'embedding',
        title: t.install.groupEmbedding,
        items: [{
                id: 'embedding',
                label: 'Embedding Model',
                enabled: true,
                summary: summaries.embeddingMode === 'api' ? 'API mode' : (summaries.embeddingCached ? 'Local (ready)' : 'Local (no model)'),
                detail: 'Manage local ONNX model for semantic search. Download, configure, rebuild index.',
                hasConfig: true,
            }],
    });
    // --- Entry Commands (always visible) ---
    const entrySteps = summaries.entryCommandSteps ?? [];
    const entryEligible = summaries.entryCommandEligible ?? 0;
    groups.push({
        id: 'entryCommands',
        title: t.install.groupEntryCommands,
        items: [{
                id: 'entryCommands',
                label: 'Entry Commands',
                enabled: entrySteps.length > 0,
                summary: entrySteps.length > 0
                    ? `${entrySteps.length}/${entryEligible} steps`
                    : '—',
                detail: `Generate slash-command wrappers for step entry points. Selected: ${entrySteps.join(', ') || 'none'}`,
                hasConfig: true,
            }],
    });
    return groups;
}
//# sourceMappingURL=GroupedHub.js.map