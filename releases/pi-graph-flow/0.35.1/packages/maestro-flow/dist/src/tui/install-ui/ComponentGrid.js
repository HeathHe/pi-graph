import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { CyberItem } from './CyberItem.js';
import { toggleSelection, restoreDefaults, moveUp, moveDown, parseNumberKey, clampIndex, } from './ComponentGrid.logic.js';
import { t } from '../../i18n/index.js';
import { C } from '../shared/index.js';
// ---------------------------------------------------------------------------
// ComponentGrid — multi-select container with category grouping + viewport
// ---------------------------------------------------------------------------
const CATEGORY_LABELS = {
    commands: '── Commands ──────────────────',
    skills: '── Skills ────────────────────',
    'platform-shared': '── Shared (Core) ─────────────',
    'platform-claude': '── Claude Code ───────────────',
    'platform-codex': '── Codex ─────────────────────',
    'platform-agy': '── Agy (Antigravity) ─────────',
    'platform-agents-standard': '── Open Standard (.agents/) ──',
};
const VIEWPORT = 20;
export function ComponentGrid({ components, selectedIds, onSelectionChange, onDone, }) {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const prevCountRef = useRef(components.length);
    useEffect(() => {
        if (components.length !== prevCountRef.current) {
            setSelectedIndex(0);
            prevCountRef.current = components.length;
        }
    }, [components.length]);
    const mandatoryIds = useMemo(() => new Set(components.filter(c => c.def.mandatory).map(c => c.def.id)), [components]);
    // Build grouped order: platform groups first, then sub-grouped by category.
    // `ordered` is the source of truth for both navigation and rendering.
    // Order: shared → claude → codex → agy → agents-standard
    const { ordered, visualRows, itemToVisualRow } = useMemo(() => {
        const PLATFORM_ORDER = ['shared', 'claude', 'codex', 'agy', 'agents-standard'];
        // Bucket components by platform (undefined → 'shared')
        const platformMap = new Map();
        for (const p of PLATFORM_ORDER)
            platformMap.set(p, []);
        for (const comp of components) {
            const plat = comp.def.platform ?? 'shared';
            if (!platformMap.has(plat))
                platformMap.set(plat, []);
            platformMap.get(plat).push(comp);
        }
        // Within each platform group, separate uncategorized from categorized
        const orderedList = [];
        const rows = [];
        const mapping = new Map();
        let itemIdx = 0;
        for (const plat of PLATFORM_ORDER) {
            const items = platformMap.get(plat);
            if (!items || items.length === 0)
                continue;
            // Platform header
            const platKey = `platform-${plat}`;
            const platLabel = CATEGORY_LABELS[platKey] || `── ${plat} ──`;
            rows.push({ type: 'header', label: platLabel, category: platKey });
            // Split into uncategorized and categorized within this platform
            const uncategorized = [];
            const catMap = new Map();
            const catOrder = [];
            for (const comp of items) {
                const cat = comp.def.category;
                if (!cat) {
                    uncategorized.push(comp);
                }
                else {
                    if (!catMap.has(cat)) {
                        catMap.set(cat, []);
                        catOrder.push(cat);
                    }
                    catMap.get(cat).push(comp);
                }
            }
            // Uncategorized items first within this platform
            for (const comp of uncategorized) {
                orderedList.push(comp);
                mapping.set(itemIdx, rows.length);
                rows.push({ type: 'item', comp, itemIndex: itemIdx });
                itemIdx++;
            }
            // Then categorized sub-groups
            for (const cat of catOrder) {
                const subLabel = CATEGORY_LABELS[cat] || `── ${cat} ──`;
                rows.push({ type: 'header', label: subLabel, category: cat });
                for (const comp of catMap.get(cat)) {
                    orderedList.push(comp);
                    mapping.set(itemIdx, rows.length);
                    rows.push({ type: 'item', comp, itemIndex: itemIdx });
                    itemIdx++;
                }
            }
        }
        return { ordered: orderedList, visualRows: rows, itemToVisualRow: mapping };
    }, [components]);
    const count = ordered.length;
    const safeIndex = clampIndex(selectedIndex, count);
    const toggleId = useCallback((id) => {
        onSelectionChange(toggleSelection(selectedIds, id, mandatoryIds));
    }, [selectedIds, mandatoryIds, onSelectionChange]);
    const toggleAt = useCallback((idx) => {
        if (idx < 0 || idx >= count)
            return;
        const comp = ordered[idx];
        if (!comp.available)
            return;
        toggleId(comp.def.id);
    }, [ordered, count, toggleId]);
    const selectAllAvailable = useCallback(() => {
        const allIds = ordered.filter((c) => c.available).map((c) => c.def.id);
        onSelectionChange(allIds);
    }, [ordered, onSelectionChange]);
    const handleDeselectAll = useCallback(() => {
        onSelectionChange(mandatoryIds.size > 0 ? Array.from(mandatoryIds) : []);
    }, [mandatoryIds, onSelectionChange]);
    const handleRestoreDefaults = useCallback(() => {
        onSelectionChange(restoreDefaults(ordered.map(c => c.def), mandatoryIds));
    }, [ordered, mandatoryIds, onSelectionChange]);
    useInput((input, key) => {
        if (key.return) {
            onDone();
            return;
        }
        if (key.upArrow) {
            setSelectedIndex((prev) => moveUp(prev, count));
            return;
        }
        if (key.downArrow) {
            setSelectedIndex((prev) => moveDown(prev, count));
            return;
        }
        if (input === ' ') {
            toggleAt(safeIndex);
            return;
        }
        if (input === 'a' || input === 'A') {
            selectAllAvailable();
            return;
        }
        if (input === 'n' || input === 'N') {
            handleDeselectAll();
            return;
        }
        if (input === 'd' || input === 'D') {
            handleRestoreDefaults();
            return;
        }
        const idx = parseNumberKey(input, count);
        if (idx >= 0) {
            toggleAt(idx);
            return;
        }
    });
    if (count === 0) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.componentsTitle }), _jsx(Text, { dimColor: true, children: t.install.componentsNone })] }));
    }
    const availableCount = ordered.filter((c) => c.available).length;
    // Viewport window around current cursor
    const cursorVisualRow = itemToVisualRow.get(safeIndex) ?? 0;
    const totalVisual = visualRows.length;
    let vStart = 0;
    let vEnd = totalVisual;
    if (totalVisual > VIEWPORT) {
        vStart = Math.max(0, cursorVisualRow - Math.floor(VIEWPORT / 2));
        vEnd = Math.min(totalVisual, vStart + VIEWPORT);
        if (vEnd - vStart < VIEWPORT)
            vStart = Math.max(0, vEnd - VIEWPORT);
    }
    const visibleRows = visualRows.slice(vStart, vEnd);
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: t.install.componentsTitle }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [vStart > 0 && _jsxs(Text, { dimColor: true, children: ["  \u2191 ", vStart, " more"] }), visibleRows.map((row, vi) => {
                        if (row.type === 'header') {
                            return (_jsx(Box, { marginTop: vi > 0 ? 1 : 0, children: _jsx(Text, { color: C.primary, children: row.label }) }, `hdr-${row.category}`));
                        }
                        const { comp, itemIndex } = row;
                        return (_jsx(CyberItem, { index: itemIndex + 1, label: comp.def.label, fileCount: comp.fileCount, selected: selectedIds.includes(comp.def.id), available: comp.available, highlighted: itemIndex === safeIndex, description: comp.def.description, mandatory: !!comp.def.mandatory }, comp.def.id));
                    }), vEnd < totalVisual && _jsxs(Text, { dimColor: true, children: ["  \u2193 ", totalVisual - vEnd, " more"] })] }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: t.install.componentsSelected
                        .replace('{selected}', String(selectedIds.length))
                        .replace('{total}', String(availableCount)) }) })] }));
}
//# sourceMappingURL=ComponentGrid.js.map