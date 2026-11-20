import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text, useInput } from 'ink';
import { selectToolByRole, } from '../../config/cli-tools-config.js';
import { C, pad } from '../shared/index.js';
// Static mapping of known --role references in commands/skills
const KNOWN_ROLE_REFS = [
    { command: 'maestro-analyze', role: 'analyze' },
    { command: 'maestro-composer', role: 'analyze' },
    { command: 'maestro-super', role: 'analyze' },
    { command: 'issue-discover', role: 'analyze' },
    { command: 'team-review/scanner', role: 'review' },
    { command: 'team-review/reviewer', role: 'review' },
    { command: 'spec-generate (product)', role: 'analyze' },
    { command: 'spec-generate (technical)', role: 'review' },
    { command: 'spec-generate (user)', role: 'explore' },
];
export function CommandReference({ config, onBack }) {
    useInput((_input, key) => {
        if (key.escape)
            onBack();
    });
    const entries = KNOWN_ROLE_REFS.map(ref => ({
        command: ref.command,
        role: ref.role,
        resolvesTo: selectToolByRole(ref.role, config)?.name ?? '(none)',
    }));
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Command Reference" }), _jsx(Text, { dimColor: true, children: "Shows which tool each command/skill resolves to via --role" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: pad('Command / Skill', 32) }), _jsx(Text, { dimColor: true, children: pad('Role', 24) }), _jsx(Text, { dimColor: true, children: "Resolves To" })] }), _jsx(Text, { dimColor: true, children: '─'.repeat(76) }), entries.map((entry, i) => (_jsxs(Box, { gap: 1, children: [_jsx(Text, { children: pad(entry.command, 32) }), _jsx(Text, { color: C.warning, children: pad(entry.role, 24) }), _jsx(Text, { color: C.success, bold: true, children: entry.resolvesTo })] }, i))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[Esc] Back" })] }));
}
//# sourceMappingURL=CommandReference.js.map