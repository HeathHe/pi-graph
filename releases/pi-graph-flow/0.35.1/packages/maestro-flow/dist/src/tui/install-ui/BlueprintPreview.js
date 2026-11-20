import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useMemo } from 'react';
import { Box, Text, useStdout } from 'ink';
import { existsSync } from 'node:fs';
import { COMPONENT_DEFS } from '../../commands/install-backend.js';
import { buildTree } from './BlueprintPreview.logic.js';
import { C } from '../shared/index.js';
const STATUS_COLOR = {
    new: C.primary,
    exists: C.warning,
    preserved: C.neutral,
};
export function BlueprintPreview({ mode, projectPath, selectedIds }) {
    const { stdout } = useStdout();
    const termRows = stdout?.rows ?? 24;
    // Resolve selected defs to target info
    const resolvedTargets = useMemo(() => {
        const idSet = new Set(selectedIds);
        return COMPONENT_DEFS
            .filter((d) => idSet.has(d.id))
            .map((def) => {
            const targetDir = def.target(mode, projectPath);
            // Determine status based on whether target already exists
            const status = existsSync(targetDir) ? 'exists' : 'new';
            return {
                def,
                targetDir,
                fileCount: 0, // real counts come from scanning; label shown as fallback
                status,
            };
        });
    }, [selectedIds, mode, projectPath]);
    const tree = useMemo(() => buildTree(resolvedTargets), [resolvedTargets]);
    // Compute total files across groups
    const totalFiles = useMemo(() => tree.reduce((sum, g) => sum + g.totalFiles, 0), [tree]);
    // Empty selection
    if (selectedIds.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Blueprint" }), _jsx(Box, { marginTop: 1, children: _jsx(Text, { dimColor: true, children: "No components selected" }) })] }));
    }
    // Reserve 8 rows for header, border, total line, etc.
    const availableHeight = Math.max(termRows - 8, 6);
    // Flatten tree into renderable lines
    const lines = [];
    for (const group of tree) {
        lines.push({ text: group.parentDir + '/', color: 'white' });
        for (let i = 0; i < group.entries.length; i++) {
            const isLast = i === group.entries.length - 1;
            const branch = isLast ? '\u2514\u2500\u2500' : '\u251C\u2500\u2500';
            const entry = group.entries[i];
            const fileStr = entry.fileCount > 0
                ? `(${entry.fileCount} files)`
                : `(${entry.label})`;
            const status = entry.status;
            const color = status ? STATUS_COLOR[status] : C.primary;
            lines.push({
                text: `  ${branch} ${entry.subPath} ${fileStr}`,
                color,
            });
        }
    }
    const truncated = lines.length > availableHeight;
    const visibleLines = truncated ? lines.slice(0, availableHeight) : lines;
    const hiddenCount = lines.length - availableHeight;
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Blueprint" }), _jsxs(Box, { flexDirection: "column", borderStyle: "round", borderColor: C.neutral, paddingX: 1, marginTop: 1, children: [visibleLines.map((line, i) => (_jsx(Text, { color: line.color, children: line.text }, i))), truncated && _jsxs(Text, { dimColor: true, children: ["[", hiddenCount, " more...]"] }), _jsxs(Text, { children: ["Total: ", selectedIds.length, " components", totalFiles > 0 ? `, ${totalFiles} files` : ''] })] })] }));
}
//# sourceMappingURL=BlueprintPreview.js.map