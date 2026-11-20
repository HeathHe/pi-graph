import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { getConfigurableParams, } from '../../config/argument-hint-parser.js';
import { resetSkillConfig, } from '../../config/skill-config.js';
import { C, SYM, SP, pad, wrapCursor, KeyHints, SectionHeader } from '../shared/index.js';
export function SkillsList({ config, commandDefs, workDir, onBack, onEdit, onReload }) {
    const [cursor, setCursor] = useState(0);
    const [filter, setFilter] = useState('');
    const [filterMode, setFilterMode] = useState(false);
    // Build sorted list: configured skills first, then rest
    const allSkills = useMemo(() => {
        const entries = [...commandDefs.entries()]
            .map(([name, def]) => ({
            name,
            def,
            configurable: getConfigurableParams(def.params).length,
            configured: config.skills[name] ? Object.keys(config.skills[name].params).length : 0,
        }))
            .sort((a, b) => {
            // Configured first, then alphabetical
            if (a.configured > 0 && b.configured === 0)
                return -1;
            if (a.configured === 0 && b.configured > 0)
                return 1;
            return a.name.localeCompare(b.name);
        });
        return entries;
    }, [commandDefs, config]);
    const filtered = useMemo(() => {
        if (!filter)
            return allSkills;
        const q = filter.toLowerCase();
        return allSkills.filter(s => s.name.toLowerCase().includes(q));
    }, [allSkills, filter]);
    // Page-based display (max 20 visible at a time)
    const PAGE_SIZE = 20;
    const pageStart = Math.floor(cursor / PAGE_SIZE) * PAGE_SIZE;
    const visible = filtered.slice(pageStart, pageStart + PAGE_SIZE);
    useInput((input, key) => {
        if (filterMode) {
            if (key.escape) {
                setFilterMode(false);
                setFilter('');
                return;
            }
            if (key.return) {
                setFilterMode(false);
                setCursor(0);
                return;
            }
            return; // TextInput handles the rest
        }
        if (key.escape) {
            onBack();
            return;
        }
        if (key.upArrow)
            setCursor(c => wrapCursor(c, -1, filtered.length));
        if (key.downArrow)
            setCursor(c => wrapCursor(c, 1, filtered.length));
        if (key.return && filtered.length > 0) {
            onEdit(filtered[cursor].name);
        }
        if (input === '/' || input === 'f') {
            setFilterMode(true);
            setFilter('');
        }
        if (input === 'x' && filtered.length > 0) {
            const skill = filtered[cursor];
            if (skill.configured > 0) {
                resetSkillConfig(skill.name, 'global', workDir);
                onReload();
            }
        }
    });
    return (_jsxs(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: [_jsx(SectionHeader, { title: `Skills (${filtered.length}/${allSkills.length})` }), filterMode ? (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "yellow", children: "Filter:" }), _jsx(TextInput, { defaultValue: filter, onSubmit: (val) => { setFilter(val); setFilterMode(false); setCursor(0); } })] })) : (filter && _jsxs(Text, { dimColor: true, children: ["Filter: ", filter] })), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsxs(Text, { dimColor: true, children: ['  ', pad('Skill', 28)] }), _jsx(Text, { dimColor: true, children: pad('Params', 8) }), _jsx(Text, { dimColor: true, children: pad('Set', 6) }), _jsx(Text, { dimColor: true, children: "Hint" })] }), _jsx(Text, { dimColor: true, children: '  ' + '─'.repeat(85) }), visible.map((skill, i) => {
                const idx = pageStart + i;
                const active = idx === cursor;
                const color = active ? 'cyan' : undefined;
                const hasConfig = skill.configured > 0;
                const hint = skill.def.argumentHint.length > 38
                    ? skill.def.argumentHint.slice(0, 35) + '...'
                    : skill.def.argumentHint;
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: hasConfig ? C.success : color, children: [active ? SYM.cursor : ' ', hasConfig ? SYM.dot : ' '] }), _jsx(Text, { bold: active, color: color, children: pad(skill.name, 28) }), _jsx(Text, { color: color, children: pad(String(skill.configurable), 8) }), _jsx(Text, { color: hasConfig ? C.warning : undefined, dimColor: !hasConfig, children: pad(hasConfig ? String(skill.configured) : '—', 6) }), _jsx(Text, { dimColor: true, children: hint || '(no params)' })] }, skill.name));
            }), filtered.length > PAGE_SIZE && (_jsxs(Text, { dimColor: true, children: ["  Page ", Math.floor(cursor / PAGE_SIZE) + 1, "/", Math.ceil(filtered.length / PAGE_SIZE)] })), _jsx(KeyHints, { hints: "[\u2191\u2193] Navigate  [Enter] Edit  [/] Filter  [x] Clear defaults  [Esc] Back" })] }));
}
//# sourceMappingURL=SkillsList.js.map