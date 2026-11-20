import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { loadSkillConfig, } from '../../config/skill-config.js';
import { loadAllCommandDefs, } from '../../config/argument-hint-parser.js';
import { checkSkillContextHook } from '../../commands/config.js';
import { SkillsList } from './SkillsList.js';
import { SkillParamEditor } from './SkillParamEditor.js';
import { ConfigSourcesView } from './ConfigSourcesView.js';
import { C, SP, BORDER, SYM, pad, KeyHints, SectionHeader, StatusBadge } from '../shared/index.js';
export function SkillConfigDashboard({ workDir, initialView, editSkill }) {
    const { exit } = useApp();
    const [view, setView] = useState(initialView ?? 'dashboard');
    const [config, setConfig] = useState(null);
    const [commandDefs, setCommandDefs] = useState(null);
    const [selectedSkill, setSelectedSkill] = useState(editSkill ?? null);
    const [hookStatus, setHookStatus] = useState('installed');
    const reload = () => {
        setConfig(loadSkillConfig(workDir));
        setCommandDefs(loadAllCommandDefs(workDir));
    };
    useEffect(() => {
        reload();
        setHookStatus(checkSkillContextHook());
        // If editSkill was provided, jump directly to editor
        if (editSkill)
            setView('editor');
    }, []);
    useInput((input, key) => {
        if (view !== 'dashboard')
            return;
        if (input === '1')
            setView('skills');
        if (input === '2')
            setView('sources');
        if (input === 'q' || key.escape)
            exit();
    });
    if (!config || !commandDefs) {
        return _jsx(Text, { dimColor: true, children: "Loading configuration..." });
    }
    if (view === 'skills') {
        return (_jsx(SkillsList, { config: config, commandDefs: commandDefs, workDir: workDir, onBack: () => { reload(); setView('dashboard'); }, onEdit: (skill) => { setSelectedSkill(skill); setView('editor'); }, onReload: reload }));
    }
    if (view === 'editor' && selectedSkill) {
        const def = commandDefs.get(selectedSkill);
        return (_jsx(SkillParamEditor, { skillName: selectedSkill, commandDef: def ?? null, config: config, workDir: workDir, onBack: () => { reload(); setView('skills'); }, onReload: reload }));
    }
    if (view === 'sources') {
        return _jsx(ConfigSourcesView, { workDir: workDir, onBack: () => { reload(); setView('dashboard'); } });
    }
    // Dashboard view
    const configuredSkills = Object.entries(config.skills);
    const totalCommands = commandDefs.size;
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "MAESTRO SKILL CONFIG" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { children: "Commands discovered:" }), _jsx(Text, { bold: true, color: C.success, children: totalCommands })] }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { children: "Skills with defaults:" }), _jsx(Text, { bold: true, color: C.warning, children: configuredSkills.length })] }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { children: "Hook (skill-context):" }), _jsx(StatusBadge, { enabled: hookStatus === 'installed', labels: { on: 'installed', off: 'not installed' } })] }), hookStatus === 'not-installed' && (_jsx(Box, { marginTop: SP.sectionGap, children: _jsx(Text, { color: C.error, children: "  Parameter injection requires the skill-context hook." }) })), hookStatus === 'not-installed' && (_jsx(Text, { dimColor: true, children: "  Run: maestro hooks install --level standard" })), configuredSkills.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Configured:" }), configuredSkills.slice(0, 8).map(([name, defaults]) => {
                                const paramCount = Object.keys(defaults.params).length;
                                return (_jsxs(Box, { gap: SP.inlineGap, children: [_jsxs(Text, { color: C.success, children: ["  ", SYM.enabled] }), _jsx(Text, { bold: true, children: pad(name, 28) }), _jsxs(Text, { dimColor: true, children: [paramCount, " param", paramCount !== 1 ? 's' : ''] })] }, name));
                            }), configuredSkills.length > 8 && (_jsxs(Text, { dimColor: true, children: ["  ... and ", configuredSkills.length - 8, " more"] }))] })), _jsx(Text, { children: " " }), _jsxs(Box, { gap: SP.tabGap, children: [_jsx(Text, { color: C.primary, children: "[1]" }), _jsx(Text, { children: "Skills" }), _jsx(Text, { color: C.primary, children: "[2]" }), _jsx(Text, { children: "Config Sources" })] })] }), _jsx(KeyHints, { hints: "[1-2] Select  [q] Quit" })] }));
}
//# sourceMappingURL=SkillConfigDashboard.js.map