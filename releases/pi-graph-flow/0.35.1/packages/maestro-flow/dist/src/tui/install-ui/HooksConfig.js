import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { HOOK_LEVELS, HOOK_DEFS, CODEX_HOOK_DEFS, AGY_HOOK_DEFS, getHooksForLevel, } from '../../commands/hooks.js';
import { t } from '../../i18n/index.js';
import { C, SYM, SP, wrapCursor, KeyHints, SectionHeader } from '../shared/index.js';
function groupByEvent(entries) {
    const map = new Map();
    for (const e of entries) {
        const list = map.get(e.event) ?? [];
        list.push(e);
        map.set(e.event, list);
    }
    return Array.from(map.entries()).map(([event, hooks]) => ({ event, hooks }));
}
export function HooksConfig({ selection, onSelectionChange, title, descriptions, tool = 'claude', }) {
    const descMap = descriptions ?? t.install.hooksLevelDescriptions;
    const sectionTitle = title ?? t.install.hooksTitle;
    const defs = tool === 'codex' ? CODEX_HOOK_DEFS
        : tool === 'agy' ? AGY_HOOK_DEFS
            : HOOK_DEFS;
    const allHooks = useMemo(() => Object.entries(defs).map(([name, def]) => ({
        name,
        event: def.event,
        level: def.level,
    })), [defs]);
    const eventGroups = useMemo(() => groupByEvent(allHooks), [allHooks]);
    // Navigation: 4 preset rows + individual hook rows
    const hookCount = allHooks.length;
    const totalRows = HOOK_LEVELS.length + hookCount;
    const [cursor, setCursor] = useState(Math.max(0, HOOK_LEVELS.indexOf(selection.basePreset)));
    const isInPresetZone = cursor < HOOK_LEVELS.length;
    const hookIndex = cursor - HOOK_LEVELS.length;
    const applyPreset = useCallback((level) => {
        const hooks = getHooksForLevel(level, tool);
        onSelectionChange({ basePreset: level, selectedHooks: hooks, isCustom: false });
    }, [tool, onSelectionChange]);
    const toggleHook = useCallback((hookName) => {
        const next = selection.selectedHooks.includes(hookName)
            ? selection.selectedHooks.filter((h) => h !== hookName)
            : [...selection.selectedHooks, hookName];
        onSelectionChange({ ...selection, selectedHooks: next, isCustom: true });
    }, [selection, onSelectionChange]);
    useInput((input, key) => {
        if (key.upArrow) {
            setCursor((i) => wrapCursor(i, -1, totalRows));
        }
        else if (key.downArrow) {
            setCursor((i) => wrapCursor(i, 1, totalRows));
        }
        else if (input === ' ') {
            if (isInPresetZone) {
                applyPreset(HOOK_LEVELS[cursor]);
            }
            else {
                toggleHook(allHooks[hookIndex].name);
            }
        }
        else if (input === 'a' || input === 'A') {
            applyPreset('full');
        }
        else if (input === 'n' || input === 'N') {
            applyPreset('none');
        }
        else {
            const num = parseInt(input, 10);
            if (!isNaN(num) && num >= 1 && num <= 4) {
                const level = HOOK_LEVELS[num - 1];
                setCursor(num - 1);
                applyPreset(level);
            }
        }
    });
    const { selectedHooks, isCustom, basePreset } = selection;
    // Status line
    const statusText = isCustom
        ? t.install.hooksCustomStatus.replace('{preset}', basePreset).replace('{count}', String(selectedHooks.length)).replace('{total}', String(hookCount))
        : t.install.hooksPresetStatus.replace('{preset}', basePreset).replace('{count}', String(selectedHooks.length)).replace('{total}', String(hookCount));
    // Pre-compute flat index for each hook to avoid mutable counter in render
    const hookFlatIndexMap = useMemo(() => {
        const map = new Map();
        let idx = 0;
        for (const group of eventGroups) {
            for (const hook of group.hooks) {
                map.set(hook.name, idx++);
            }
        }
        return map;
    }, [eventGroups]);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: sectionTitle }), _jsx(Box, { marginTop: SP.sectionGap, gap: 2, children: HOOK_LEVELS.map((lvl, i) => {
                    const isActive = lvl === basePreset && !isCustom;
                    const hl = cursor === i;
                    const label = lvl.charAt(0).toUpperCase() + lvl.slice(1);
                    return (_jsxs(Box, { children: [_jsx(Text, { color: isActive ? C.success : C.neutral, children: isActive ? SYM.radioOn : SYM.radioOff }), _jsxs(Text, { color: hl ? C.primary : C.neutral, children: [" ", i + 1, " "] }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: label })] }, lvl));
                }) }), isInPresetZone && descMap[HOOK_LEVELS[cursor]] && (_jsx(Box, { marginLeft: 2, children: _jsx(Text, { color: C.neutral, children: descMap[HOOK_LEVELS[cursor]] }) })), _jsxs(Box, { flexDirection: "column", marginTop: SP.sectionGap, children: [_jsxs(Text, { color: C.neutral, dimColor: true, children: ['─'.repeat(2), " ", t.install.hooksIndividual, " ", '─'.repeat(30)] }), eventGroups.map((group) => (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: C.neutral, dimColor: true, children: ["  ", group.event] }), group.hooks.map((hook) => {
                                const idx = HOOK_LEVELS.length + (hookFlatIndexMap.get(hook.name) ?? 0);
                                const hl = cursor === idx;
                                const checked = selectedHooks.includes(hook.name);
                                return (_jsxs(Box, { children: [_jsx(Text, { color: hl ? C.primary : undefined, children: "  " }), _jsx(Text, { color: checked ? (hl ? C.successBright : C.success) : C.neutral, children: checked ? SYM.checkOn : SYM.checkOff }), _jsxs(Text, { color: hl ? C.primary : undefined, bold: hl, children: [' ', hook.name.padEnd(24)] }), _jsx(Text, { dimColor: true, children: hook.level })] }, hook.name));
                            })] }, group.event)))] }), _jsxs(Box, { marginTop: SP.sectionGap, children: [_jsx(Text, { dimColor: true, children: "Level: " }), _jsx(Text, { color: isCustom ? C.warning : C.success, children: statusText })] }), _jsx(KeyHints, { hints: t.install.hooksKeyHints })] }));
}
//# sourceMappingURL=HooksConfig.js.map