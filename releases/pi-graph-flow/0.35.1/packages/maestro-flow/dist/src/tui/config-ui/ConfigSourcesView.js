import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { loadSkillConfigSources, } from '../../config/skill-config.js';
import { C, SYM } from '../shared/index.js';
export function ConfigSourcesView({ workDir, onBack }) {
    const [data, setData] = useState(null);
    useEffect(() => { setData(loadSkillConfigSources(workDir)); }, []);
    useInput((_input, key) => { if (key.escape)
        onBack(); });
    if (!data)
        return _jsx(Text, { dimColor: true, children: "Loading..." });
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Skill Config Sources" }), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Global" }), _jsxs(Text, { dimColor: true, children: ["  ", data.globalPath] }), data.global ? (_jsx(SkillConfigSection, { config: data.global, indent: 2 })) : (_jsx(Text, { dimColor: true, color: C.warning, children: "  (not found)" })), _jsx(Text, { children: " " }), _jsx(Text, { bold: true, children: "Workspace" }), _jsxs(Text, { dimColor: true, children: ["  ", data.workspacePath ?? `${workDir}/.maestro/skill-config.json`] }), data.workspace ? (_jsx(SkillConfigSection, { config: data.workspace, indent: 2 })) : (_jsx(Text, { dimColor: true, color: C.warning, children: "  (not found)" })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "Workspace overrides global (per-skill, params deep-merged). [Esc] Back" })] }));
}
function SkillConfigSection({ config, indent }) {
    const pad = ' '.repeat(indent);
    const skills = Object.entries(config.skills);
    if (skills.length === 0) {
        return _jsxs(Text, { dimColor: true, children: [pad, "(no skills configured)"] });
    }
    return (_jsx(Box, { flexDirection: "column", children: skills.map(([name, defaults]) => {
            const params = Object.entries(defaults.params);
            return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: pad }), _jsx(Text, { color: C.success, children: SYM.dot }), _jsx(Text, { bold: true, children: name }), _jsxs(Text, { dimColor: true, children: ["(", params.length, " param", params.length !== 1 ? 's' : '', ")"] })] }), params.map(([param, value]) => (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { children: [pad, "  "] }), _jsx(Text, { color: C.warning, children: param }), _jsxs(Text, { children: ["= ", String(value)] })] }, param)))] }, name));
        }) }));
}
//# sourceMappingURL=ConfigSourcesView.js.map