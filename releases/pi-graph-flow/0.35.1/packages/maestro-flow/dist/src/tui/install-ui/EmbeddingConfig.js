import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { C } from '../shared/index.js';
export function EmbeddingConfig({ status, downloading, downloadProgress, onDownloadModel, onSwitchMode, onRebuildIndex, }) {
    const [cursor, setCursor] = useState(0);
    const actions = status?.mode === 'local'
        ? ['download', 'rebuild', 'switch-api']
        : ['switch-local', 'rebuild'];
    useInput((input, key) => {
        if (key.upArrow)
            setCursor(i => Math.max(0, i - 1));
        else if (key.downArrow)
            setCursor(i => Math.min(actions.length - 1, i + 1));
        else if (input === ' ' || key.return) {
            const action = actions[cursor];
            if (action === 'download')
                onDownloadModel();
            else if (action === 'rebuild')
                onRebuildIndex();
            else if (action === 'switch-api')
                onSwitchMode('api');
            else if (action === 'switch-local')
                onSwitchMode('local');
        }
        else {
            const num = parseInt(input, 10);
            if (num >= 1 && num <= actions.length) {
                setCursor(num - 1);
                const action = actions[num - 1];
                if (action === 'download')
                    onDownloadModel();
                else if (action === 'rebuild')
                    onRebuildIndex();
                else if (action === 'switch-api')
                    onSwitchMode('api');
                else if (action === 'switch-local')
                    onSwitchMode('local');
            }
        }
    });
    if (!status) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Embedding Model" }), _jsx(Text, { dimColor: true, children: "Loading status..." })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Embedding Model Management" }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Box, { children: [_jsx(Text, { children: "Mode: " }), _jsx(Text, { bold: true, color: status.mode === 'local' ? C.success : C.accent, children: status.mode === 'local' ? 'Local (ONNX)' : 'API (External)' })] }), _jsxs(Box, { children: [_jsx(Text, { children: "Model: " }), _jsx(Text, { color: C.primary, children: status.modelId }), status.mode === 'local' && status.modelId.includes('/') && status.modelId.length > 30 && (_jsx(Text, { dimColor: true, children: " (local folder)" }))] }), _jsxs(Box, { children: [_jsx(Text, { children: "Dimension: " }), _jsxs(Text, { children: [status.dimension, "d"] })] }), status.mode === 'local' && (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { children: "Cached: " }), _jsx(Text, { color: status.modelCached ? C.success : C.error, children: status.modelCached ? 'Yes' : 'No (needs download ~465MB)' })] }), _jsxs(Box, { children: [_jsx(Text, { children: "Device: " }), _jsxs(Text, { color: status.gpuAvailable ? C.success : C.neutral, children: [status.device, "/", status.dtype, " batch=", status.batchSize, status.gpuAvailable ? ' (GPU)' : ' (CPU)'] })] })] }))] }), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Index Status" }), _jsxs(Box, { children: [_jsx(Text, { children: "Wiki: " }), _jsx(Text, { color: status.wikiIndexDocs > 0 ? C.success : C.neutral, children: status.wikiIndexDocs > 0
                                    ? `${status.wikiIndexDocs} docs (${status.wikiIndexBuiltAt})`
                                    : 'Not built' })] }), _jsxs(Box, { children: [_jsx(Text, { children: "Code: " }), _jsx(Text, { color: status.codeIndexNodes > 0 ? C.success : C.neutral, children: status.codeIndexNodes > 0
                                    ? `${status.codeIndexNodes} nodes (${status.codeIndexBuiltAt})`
                                    : 'Not built' })] })] }), downloading && (_jsx(Box, { marginTop: 1, children: _jsxs(Text, { color: C.warning, children: ["Downloading... ", downloadProgress > 0 ? `${downloadProgress}%` : ''] }) })), _jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, color: C.primary, children: "Actions" }), actions.map((action, i) => {
                        const hl = cursor === i;
                        const label = action === 'download' ? 'Download local model (~465MB)'
                            : action === 'rebuild' ? 'Rebuild embedding index'
                                : action === 'switch-api' ? 'Switch to API mode'
                                    : 'Switch to local mode';
                        return (_jsxs(Box, { children: [_jsxs(Text, { color: hl ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: hl ? C.primary : undefined, bold: hl, children: [" ", label] })] }, action));
                    })] }), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["[Up/Down] Navigate  [Space/Enter/1-", actions.length, "] Execute  [Esc] Back"] }) })] }));
}
//# sourceMappingURL=EmbeddingConfig.js.map