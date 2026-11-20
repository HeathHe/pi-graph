import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useCallback, useMemo, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { C, SYM } from '../shared/index.js';
import { scanToggleItems, applyToggle, updateManifestDisabledItems, } from '../../commands/install-backend.js';
// ---------------------------------------------------------------------------
// ToggleView — Tab-based TUI for managing commands, skills, agents
//
// Three states per item:
//   on        = installed & enabled  (✓ green)
//   off       = installed & disabled (✗ red)
//   available = in source, not yet installed (· dim)
//
// Tab switches between Commands / Skills / Agents tabs.
// Space toggles: available→on, on→off, off→on
// ---------------------------------------------------------------------------
const TABS = [
    { type: 'command', label: 'Commands' },
    { type: 'skill', label: 'Skills' },
    { type: 'agent', label: 'Agents' },
];
const STATE_DISPLAY = {
    on: { sym: SYM.checkOn, color: C.success, label: '' },
    off: { sym: SYM.checkOff, color: C.error, label: '[disabled]' },
    available: { sym: '·', color: C.neutral, label: '[not installed]' },
};
export function ToggleView({ pkgRoot, targetBase, scope, targetPath, filter }) {
    const { exit } = useApp();
    const [allItems, setAllItems] = useState(() => scanToggleItems(pkgRoot, targetBase));
    const [activeTab, setActiveTab] = useState(() => {
        if (filter) {
            const idx = TABS.findIndex((t) => t.type === filter);
            return idx >= 0 ? idx : 0;
        }
        return 0;
    });
    const [cursor, setCursor] = useState(0);
    const [dirty, setDirty] = useState(false);
    const tabItems = useMemo(() => allItems.filter((i) => i.type === TABS[activeTab].type), [allItems, activeTab]);
    const count = tabItems.length;
    const safeIdx = count > 0 ? Math.min(cursor, count - 1) : 0;
    useEffect(() => {
        if (cursor >= count)
            setCursor(Math.max(0, count - 1));
    }, [activeTab, count, cursor]);
    const handleToggle = useCallback((idx) => {
        if (idx < 0 || idx >= count)
            return;
        const item = tabItems[idx];
        if (applyToggle(item, pkgRoot)) {
            setAllItems((prev) => {
                const key = `${item.type}:${item.name}`;
                return prev.map((it) => {
                    if (`${it.type}:${it.name}` !== key)
                        return it;
                    const nextState = it.state === 'on' ? 'off' : 'on';
                    return { ...it, state: nextState };
                });
            });
            setDirty(true);
        }
    }, [tabItems, count, pkgRoot]);
    const switchTab = useCallback((dir) => {
        const tabs = filter ? [TABS.findIndex((t) => t.type === filter)] : [0, 1, 2];
        if (tabs.length <= 1)
            return;
        setActiveTab((prev) => (prev + dir + TABS.length) % TABS.length);
        setCursor(0);
    }, [filter]);
    const handleSave = useCallback(() => {
        const disabled = allItems
            .filter((i) => i.state === 'off')
            .map((i) => `${i.type}:${i.name}`);
        updateManifestDisabledItems(scope, targetPath, disabled);
        exit();
    }, [allItems, scope, targetPath, exit]);
    useInput((input, key) => {
        if (key.escape) {
            if (dirty)
                handleSave();
            exit();
            return;
        }
        if (key.return) {
            handleSave();
            return;
        }
        if (key.tab) {
            switchTab(key.shift ? -1 : 1);
            return;
        }
        if (key.upArrow) {
            setCursor((i) => (i - 1 + count) % count);
            return;
        }
        if (key.downArrow) {
            setCursor((i) => (i + 1) % count);
            return;
        }
        if (input === ' ') {
            handleToggle(safeIdx);
            return;
        }
    });
    const tabCounts = useMemo(() => {
        const m = {};
        for (const t of TABS) {
            const list = allItems.filter((i) => i.type === t.type);
            m[t.type] = { on: list.filter((i) => i.state === 'on').length, total: list.length };
        }
        return m;
    }, [allItems]);
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Maestro Toggle" }), _jsx(Text, { dimColor: true, children: "\u2423 toggle  Tab switch  \u21B5 save & exit" }), _jsx(Box, { marginTop: 1, gap: 2, children: TABS.map((tab, i) => {
                    const active = i === activeTab;
                    const c = tabCounts[tab.type];
                    return (_jsxs(Text, { bold: active, color: active ? C.primary : C.neutral, children: [active ? '▸ ' : '  ', tab.label, " (", c.on, "/", c.total, ")"] }, tab.type));
                }) }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: count === 0 ? (_jsx(Text, { dimColor: true, children: "  No items in this category." })) : ((() => {
                    const VIEWPORT = 20;
                    let start = 0;
                    let end = count;
                    if (count > VIEWPORT) {
                        start = Math.max(0, safeIdx - Math.floor(VIEWPORT / 2));
                        end = Math.min(count, start + VIEWPORT);
                        if (end - start < VIEWPORT)
                            start = Math.max(0, end - VIEWPORT);
                    }
                    const visible = tabItems.slice(start, end);
                    return (_jsxs(_Fragment, { children: [start > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", start, " more"] }), visible.map((item, vi) => {
                                const i = start + vi;
                                const hl = i === safeIdx;
                                const d = STATE_DISPLAY[item.state];
                                return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: [hl ? SYM.cursor : ' ', " "] }), _jsx(Text, { color: hl ? (item.state === 'on' ? C.successBright : d.color) : d.color, children: d.sym }), _jsx(Text, { children: " " }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: item.name.padEnd(32) }), d.label && _jsx(Text, { dimColor: true, children: d.label })] }, item.name));
                            }), end < count && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", count - end, " more"] })] }));
                })()) }), dirty && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: C.warning, children: "  Changes applied. Press \u21B5 to save manifest." }) }))] }));
}
//# sourceMappingURL=ToggleView.js.map