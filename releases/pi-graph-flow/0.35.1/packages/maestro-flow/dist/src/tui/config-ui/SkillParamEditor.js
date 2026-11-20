import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { getConfigurableParams, } from '../../config/argument-hint-parser.js';
import { setSkillParam, unsetSkillParam, } from '../../config/skill-config.js';
import { pad } from '../shared/index.js';
export function SkillParamEditor({ skillName, commandDef, config, workDir, onBack, onReload, }) {
    const params = useMemo(() => {
        if (!commandDef)
            return [];
        return getConfigurableParams(commandDef.params);
    }, [commandDef]);
    const defaults = config.skills[skillName]?.params ?? {};
    const [cursor, setCursor] = useState(0);
    const [mode, setMode] = useState('list');
    const [editValue, setEditValue] = useState('');
    const [pendingSave, setPendingSave] = useState(null);
    useInput((input, key) => {
        if (mode === 'edit-value') {
            if (key.escape) {
                setMode('list');
                return;
            }
            if (key.return) {
                // Commit edit
                const param = params[cursor];
                if (param && editValue.trim()) {
                    const parsed = parseInputValue(editValue, param);
                    setPendingSave({ param: param.name, value: parsed });
                    setMode('scope-select');
                }
                else {
                    setMode('list');
                }
                return;
            }
            return; // TextInput handles the rest
        }
        if (mode === 'scope-select') {
            if (input === 'g' && pendingSave) {
                setSkillParam(skillName, pendingSave.param, pendingSave.value, 'global');
                setPendingSave(null);
                setMode('list');
                onReload();
                return;
            }
            if (input === 'p' && pendingSave) {
                setSkillParam(skillName, pendingSave.param, pendingSave.value, 'workspace', workDir);
                setPendingSave(null);
                setMode('list');
                onReload();
                return;
            }
            if (key.escape) {
                setPendingSave(null);
                setMode('list');
                return;
            }
            return;
        }
        // list mode
        if (key.escape) {
            onBack();
            return;
        }
        if (params.length === 0)
            return;
        if (key.upArrow)
            setCursor(c => c > 0 ? c - 1 : params.length - 1);
        if (key.downArrow)
            setCursor(c => c < params.length - 1 ? c + 1 : 0);
        const param = params[cursor];
        if (!param)
            return;
        if (input === ' ') {
            // Toggle boolean / cycle enum
            if (param.type === 'boolean') {
                const current = defaults[param.name];
                const newVal = current === true ? false : true;
                setPendingSave({ param: param.name, value: newVal });
                setMode('scope-select');
            }
            else if (param.type === 'enum' && param.choices) {
                const current = defaults[param.name];
                const idx = param.choices.indexOf(String(current));
                const next = param.choices[(idx + 1) % param.choices.length];
                setPendingSave({ param: param.name, value: next });
                setMode('scope-select');
            }
        }
        if (key.return || input === 'e') {
            // Enter edit mode for string/number, or toggle boolean
            if (param.type === 'boolean') {
                const current = defaults[param.name];
                const newVal = current === true ? false : true;
                setPendingSave({ param: param.name, value: newVal });
                setMode('scope-select');
            }
            else {
                setEditValue(defaults[param.name] !== undefined ? String(defaults[param.name]) : '');
                setMode('edit-value');
            }
        }
        if (input === 'd') {
            // Delete current param default
            if (defaults[param.name] !== undefined) {
                unsetSkillParam(skillName, param.name, 'global');
                unsetSkillParam(skillName, param.name, 'workspace', workDir);
                onReload();
            }
        }
    });
    if (!commandDef) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "red", children: ["Skill not found: ", skillName] }), _jsx(Text, { dimColor: true, children: "No matching command in .claude/commands/" }), _jsx(Text, { dimColor: true, children: "[Esc] Back" })] }));
    }
    if (params.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: skillName }), _jsxs(Text, { dimColor: true, children: ["hint: ", commandDef.argumentHint || '(none)'] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "No configurable parameters (only positional args)." }), _jsx(Text, { dimColor: true, children: "[Esc] Back" })] }));
    }
    // Scope selection overlay
    if (mode === 'scope-select' && pendingSave) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Save: ", pendingSave.param, " = ", String(pendingSave.value)] }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: "yellow", children: "[g]" }), _jsx(Text, { children: "Global (~/.maestro/)" })] }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { color: "yellow", children: "[p]" }), _jsx(Text, { children: "Project (.maestro/)" })] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[Esc] Cancel" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: skillName }), _jsxs(Text, { dimColor: true, children: ["hint: ", commandDef.argumentHint] }), _jsx(Text, { children: " " }), params.map((param, i) => {
                const active = i === cursor;
                const color = active ? 'cyan' : undefined;
                const hasValue = defaults[param.name] !== undefined;
                const displayValue = hasValue ? String(defaults[param.name]) : '<not set>';
                const typeHint = formatTypeHint(param);
                const isEditing = mode === 'edit-value' && active;
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: color, children: active ? '▸' : ' ' }), _jsx(Text, { bold: active, color: color, children: pad(param.name, 20) }), isEditing ? (_jsx(Box, { children: _jsx(TextInput, { defaultValue: editValue, onSubmit: (val) => {
                                    const param = params[cursor];
                                    if (param && val.trim()) {
                                        const parsed = parseInputValue(val, param);
                                        setPendingSave({ param: param.name, value: parsed });
                                        setMode('scope-select');
                                    }
                                    else {
                                        setMode('list');
                                    }
                                } }) })) : (_jsxs(_Fragment, { children: [param.type === 'boolean' ? (_jsxs(Text, { color: hasValue ? (defaults[param.name] ? 'green' : 'red') : undefined, children: [hasValue ? (defaults[param.name] ? '[x]' : '[ ]') : '[ ]', ' ', displayValue] })) : (_jsx(Text, { color: hasValue ? 'yellow' : undefined, dimColor: !hasValue, children: pad(displayValue, 16) })), _jsxs(Text, { dimColor: true, children: ["(", typeHint, ")"] })] }))] }, param.name));
            }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [Space] Toggle/Cycle  [Enter] Edit  [d] Delete  [Esc] Back" })] }));
}
function formatTypeHint(param) {
    if (param.type === 'enum' && param.choices) {
        return param.choices.join('|');
    }
    return param.type;
}
function parseInputValue(raw, param) {
    if (param.type === 'boolean') {
        return raw === 'true' || raw === '1' || raw === 'yes';
    }
    if (param.type === 'number') {
        const num = Number(raw);
        return isNaN(num) ? raw : num;
    }
    return raw;
}
//# sourceMappingURL=SkillParamEditor.js.map