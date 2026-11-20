import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { useState } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { SkillConfigDashboard } from './SkillConfigDashboard.js';
import { ToolsDashboard } from '../tools-ui/ToolsDashboard.js';
import { HooksPanel } from './HooksPanel.js';
import { SpecPanel } from './SpecPanel.js';
import { SpecAnalyticsPanel } from './SpecAnalyticsPanel.js';
import { C, SP, BORDER, KeyHints, SectionHeader, wrapCursor } from '../shared/index.js';
const TABS = ['Skills', 'Delegate', 'Hooks', 'Overlay', 'Specs', 'Analytics', 'Install'];
const TAB_DESCRIPTIONS = {
    Skills: 'Skill parameter defaults — configure default flag values for slash commands.',
    Delegate: 'Delegate tool configuration — manage CLI tools, role mappings, and settings.',
    Hooks: 'Hook installation status — Claude Code subprocess hooks and toggles.',
    Overlay: 'Command overlays — non-invasive patches for .claude/commands and .codex/skills.',
    Specs: 'Spec system — project knowledge (coding, arch, debug, test conventions).',
    Analytics: 'Spec injection analytics — hit rates, keyword matches, hook invocations, and CLI usage.',
    Install: 'Install / uninstall maestro assets — components, hooks, MCP server.',
};
export function ConfigHub({ workDir, initialTab = 'Skills', skillsInitialView, editSkill, delegateInitialView, }) {
    const { exit } = useApp();
    const [tabIdx, setTabIdx] = useState(TABS.indexOf(initialTab));
    const tab = TABS[tabIdx];
    // Once the user enters a sub-dashboard, hand off input to it
    const [entered, setEntered] = useState(!!(skillsInitialView || editSkill || delegateInitialView));
    useInput((input, key) => {
        if (entered)
            return;
        if (key.leftArrow)
            setTabIdx(i => wrapCursor(i, -1, TABS.length));
        if (key.rightArrow || input === '\t')
            setTabIdx(i => wrapCursor(i, 1, TABS.length));
        if (key.return)
            setEntered(true);
        if (input === 'q' || key.escape)
            exit();
    });
    if (entered) {
        const backToHub = () => setEntered(false);
        if (tab === 'Skills') {
            return (_jsx(SkillConfigDashboard, { workDir: workDir, initialView: skillsInitialView, editSkill: editSkill }));
        }
        if (tab === 'Delegate') {
            return (_jsx(ToolsDashboard, { workDir: workDir, initialView: delegateInitialView }));
        }
        if (tab === 'Hooks') {
            return _jsx(HooksPanel, { workDir: workDir, onBack: backToHub });
        }
        if (tab === 'Overlay') {
            return _jsx(OverlayLauncher, { onBack: backToHub });
        }
        if (tab === 'Specs') {
            return _jsx(SpecPanel, { workDir: workDir, onBack: backToHub });
        }
        if (tab === 'Analytics') {
            return _jsx(SpecAnalyticsPanel, { workDir: workDir, onBack: backToHub });
        }
        if (tab === 'Install') {
            return _jsx(InstallLauncher, { onBack: backToHub });
        }
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "MAESTRO CONFIG" }), _jsx(Text, { children: " " }), _jsx(Box, { gap: SP.tabGap, children: TABS.map((t, i) => (_jsx(Box, { children: i === tabIdx
                                ? _jsx(Text, { bold: true, inverse: true, color: C.primary, children: ` ${t} ` })
                                : _jsx(Text, { color: C.neutral, children: ` ${t} ` }) }, t))) }), _jsx(Text, { children: " " }), _jsx(Text, { children: TAB_DESCRIPTIONS[tab] })] }), _jsx(KeyHints, { hints: "[\u2190/\u2192] Switch tab  [Enter] Enter  [q] Quit" })] }));
}
// ---------------------------------------------------------------------------
// Overlay panel — embeds OverlayList directly with live data
// ---------------------------------------------------------------------------
function OverlayLauncher({ onBack }) {
    const [OverlayList, setOverlayList] = useState(null);
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    React.useEffect(() => {
        (async () => {
            const { prepareOverlayData } = await import('../overlay-ui/index.js');
            const { OverlayList: OL } = await import('../overlay-ui/OverlayList.js');
            const d = prepareOverlayData();
            if (!d) {
                setError('No overlays installed.');
            }
            else {
                setData(d);
                setOverlayList(() => OL);
            }
        })();
    }, []);
    if (error) {
        return _jsx(OverlayFallback, { message: error, onBack: onBack });
    }
    if (!OverlayList || !data) {
        return _jsx(Text, { dimColor: true, children: "Loading overlays..." });
    }
    return React.createElement(OverlayList, {
        overlays: data.overlays,
        errors: data.errors,
        appliedState: data.appliedState,
        targets: data.targets,
        interactive: !!process.stdin.isTTY,
        onDelete: data.handleDelete,
    });
}
function OverlayFallback({ message, onBack }) {
    useInput((input, key) => {
        if (input === 'q' || key.escape)
            onBack();
    });
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "OVERLAY MANAGER" }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: message }), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  CLI: maestro overlay add ", '<', "file", '>'] }), _jsx(Text, { dimColor: true, children: "       maestro overlay apply" })] }), _jsx(KeyHints, { hints: "[q] Back to hub" })] }));
}
// ---------------------------------------------------------------------------
// Install launcher — entry to install/uninstall flows
// ---------------------------------------------------------------------------
function InstallLauncher({ onBack }) {
    const [choice, setChoice] = useState('menu');
    const [cursor, setCursor] = useState(0);
    const options = ['Install (full wizard)', 'Uninstall'];
    useInput((input, key) => {
        if (choice !== 'menu')
            return;
        if (key.upArrow)
            setCursor(c => wrapCursor(c, -1, options.length));
        if (key.downArrow)
            setCursor(c => wrapCursor(c, 1, options.length));
        if (key.return) {
            setChoice(cursor === 0 ? 'install' : 'uninstall');
        }
        if (input === 'q' || key.escape)
            onBack();
    });
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "INSTALL / UNINSTALL" }), _jsx(Text, { children: " " }), _jsx(Text, { children: "Launch the install or uninstall wizard from the CLI:" }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  CLI: maestro install          \u2014 interactive install wizard" }), _jsx(Text, { dimColor: true, children: "       maestro install wizard    \u2014 full TUI wizard" }), _jsx(Text, { dimColor: true, children: "       maestro uninstall         \u2014 remove installed assets" })] }), _jsx(KeyHints, { hints: "[q] Back to hub" })] }));
}
//# sourceMappingURL=ConfigHub.js.map