import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { C, SP, truncate as sharedTruncate, wrapCursor, KeyHints, SectionHeader, CursorMarker } from '../shared/index.js';
/** Group markers by overlay name within a section. */
function groupMarkersByOverlay(markers) {
    const map = new Map();
    for (const m of markers) {
        const list = map.get(m.overlayName) ?? [];
        list.push(m);
        map.set(m.overlayName, list);
    }
    return map;
}
// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function OverlayInfo({ overlay, applied, maxWidth, }) {
    const enabled = overlay.meta.enabled === false ? 'disabled' : 'enabled';
    const prio = overlay.meta.priority ?? 50;
    const status = applied && applied.appliedScopes.length > 0
        ? `applied[${applied.appliedScopes.join(',')}]`
        : 'pending';
    const cli = overlay.meta.cli ?? 'claude';
    const desc = overlay.meta.description ?? '';
    const targets = overlay.meta.targets.join(', ');
    // Header line: name + status
    const headerExtra = `  [${enabled}]  priority=${prio}  ${status}`;
    const nameMaxLen = maxWidth - headerExtra.length - 4;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { children: [_jsx(Text, { color: "cyan", bold: true, children: sharedTruncate(overlay.meta.name, Math.max(10, nameMaxLen)) }), _jsx(Text, { dimColor: true, children: headerExtra })] }), _jsxs(Text, { dimColor: true, children: ["    targets: ", targets, "  cli=", cli] }), desc ? _jsxs(Text, { dimColor: true, children: ["    ", sharedTruncate(desc, maxWidth - 4)] }) : null] }));
}
function SectionMapView({ targets, maxWidth, }) {
    if (targets.length === 0)
        return null;
    return (_jsx(Box, { flexDirection: "column", marginTop: 1, children: targets.map((t) => {
            const overlayNames = new Set(t.markers.map((m) => m.overlayName));
            // Build section -> markers lookup
            const sectionMarkers = new Map();
            for (const marker of t.markers) {
                let sectionName = '(outside sections)';
                for (const sec of t.sections) {
                    if (marker.line > sec.openLine && marker.line < sec.closeLine) {
                        sectionName = sec.name;
                        break;
                    }
                }
                const list = sectionMarkers.get(sectionName) ?? [];
                list.push(marker);
                sectionMarkers.set(sectionName, list);
            }
            const cliBadge = t.cli === 'codex' ? ' [codex]' : ' [claude]';
            const fileName = t.cli === 'codex' ? `${t.name}/SKILL.md` : `${t.name}.md`;
            return (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Text, { bold: true, children: ['=== ', fileName, _jsx(Text, { color: t.cli === 'codex' ? 'magenta' : 'blue', children: cliBadge }), ` (${overlayNames.size} overlay${overlayNames.size !== 1 ? 's' : ''}) ===`] }), t.sections.map((sec) => {
                        const lineRange = `L${sec.openLine + 1}-L${sec.closeLine + 1}`;
                        const secMs = sectionMarkers.get(sec.name);
                        const grouped = secMs ? groupMarkersByOverlay(secMs) : new Map();
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { children: [_jsxs(Text, { dimColor: true, children: ['  ', `[${lineRange}]`.padEnd(14)] }), _jsx(Text, { color: "yellow", children: `<${sec.name}>` })] }), [...grouped.entries()].map(([ovName, patches]) => {
                                    const patchNums = patches.map((p) => `#${p.patchIdx}`).join(', ');
                                    const desc = patches[0].description;
                                    const descText = desc
                                        ? `  "${sharedTruncate(desc, maxWidth - 30 - ovName.length)}"`
                                        : '';
                                    return (_jsxs(Text, { children: ['                   \u251c\u2500 ', _jsx(Text, { color: "green", children: ovName }), _jsxs(Text, { dimColor: true, children: [" (", patchNums, ")", descText] })] }, ovName));
                                })] }, sec.name));
                    })] }, `${t.cli}:${t.name}`));
        }) }));
}
// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function OverlayList({ overlays: initialOverlays, errors, appliedState: initialApplied, targets: initialTargets, interactive, onDelete, }) {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const maxWidth = stdout?.columns ?? 80;
    const [overlays, setOverlays] = useState(initialOverlays);
    const [appliedState, setAppliedState] = useState(initialApplied);
    const [targets, setTargets] = useState(initialTargets);
    const [mode, setMode] = useState(interactive ? 'view' : 'view');
    const [cursor, setCursor] = useState(0);
    const [message, setMessage] = useState('');
    const overlayNames = useMemo(() => overlays.map((o) => o.meta.name), [overlays]);
    useInput((input, key) => {
        if (!interactive) {
            // Any key exits in non-interactive mode
            if (key.return || key.escape || input === 'q')
                exit();
            return;
        }
        if (mode === 'view') {
            if (input === 'd' && overlays.length > 0) {
                setMode('select');
                setCursor(0);
                setMessage('');
            }
            else if (input === 'q' || key.escape) {
                exit();
            }
        }
        else if (mode === 'select') {
            if (key.upArrow) {
                setCursor((c) => wrapCursor(c, -1, overlayNames.length));
            }
            else if (key.downArrow) {
                setCursor((c) => wrapCursor(c, 1, overlayNames.length));
            }
            else if (key.return) {
                const name = overlayNames[cursor];
                if (name) {
                    onDelete(name);
                    // Update local state: remove deleted overlay
                    setOverlays((prev) => prev.filter((o) => o.meta.name !== name));
                    setAppliedState((prev) => {
                        const next = new Map(prev);
                        next.delete(name);
                        return next;
                    });
                    setTargets((prev) => prev.map((t) => ({
                        ...t,
                        markers: t.markers.filter((m) => m.overlayName !== name),
                    })).filter((t) => t.markers.length > 0 || t.sections.length > 0));
                    setMessage(`Deleted "${name}"`);
                    setCursor(0);
                    setMode('view');
                }
            }
            else if (key.escape) {
                setMode('view');
            }
        }
    });
    // If all overlays removed
    if (overlays.length === 0 && errors.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { children: "No overlays installed." }), message ? _jsx(Text, { color: "green", children: message }) : null] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(SectionHeader, { title: "Overlays" }), _jsx(Box, { flexDirection: "column", marginTop: 1, children: overlays.map((o) => (_jsx(OverlayInfo, { overlay: o, applied: appliedState.get(o.meta.name), maxWidth: maxWidth }, o.meta.name))) }), errors.length > 0 ? (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { color: "red", bold: true, children: "Load errors:" }), errors.map((e, i) => (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { color: "red", children: ['  ! ', e.path] }), e.errors.map((msg, j) => (_jsxs(Text, { dimColor: true, children: ['      ', msg] }, j)))] }, i)))] })) : null, _jsx(SectionMapView, { targets: targets, maxWidth: maxWidth }), message ? (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: "green", children: message }) })) : null, mode === 'select' ? (_jsxs(Box, { flexDirection: "column", marginTop: SP.sectionGap, children: [_jsx(Text, { bold: true, color: C.warning, children: "Select overlay to delete:" }), overlayNames.map((name, i) => {
                        const hl = i === cursor;
                        const ov = overlays.find((o) => o.meta.name === name);
                        const desc = ov?.meta.description ?? ov?.meta.targets.join(', ') ?? '';
                        return (_jsxs(Box, { children: [_jsx(CursorMarker, { active: hl }), _jsx(Text, { color: hl ? C.primary : undefined, bold: hl, children: name }), _jsxs(Text, { dimColor: true, children: [" ", '\u2014', " ", sharedTruncate(desc, maxWidth - name.length - 6)] })] }, name));
                    }), _jsx(KeyHints, { hints: "[Enter] Delete  [Esc] Cancel" })] })) : null, interactive && mode === 'view' ? (_jsx(KeyHints, { hints: `${overlays.length > 0 ? '[d] Delete  ' : ''}[q] Quit` })) : null] }));
}
//# sourceMappingURL=OverlayList.js.map