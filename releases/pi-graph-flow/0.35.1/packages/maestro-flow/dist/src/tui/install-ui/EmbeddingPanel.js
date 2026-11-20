import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import { C } from '../shared/index.js';
export function EmbeddingPanel({ onDone }) {
    const [status, setStatus] = useState(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(null);
    const [message, setMessage] = useState(null);
    const [cursor, setCursor] = useState(0);
    const actions = status?.mode === 'local'
        ? [
            { id: 'download', label: status?.modelCached ? 'Re-download model' : 'Download model (~465MB)' },
            { id: 'rebuild', label: 'Rebuild code embedding index' },
            { id: 'switch', label: 'Switch to API mode' },
        ]
        : [
            { id: 'switch', label: 'Switch to local mode' },
            { id: 'rebuild', label: 'Rebuild code embedding index' },
        ];
    useEffect(() => {
        import('./embedding-status.js').then(({ getEmbeddingStatus }) => getEmbeddingStatus(process.cwd()).then(s => { setStatus(s); setLoading(false); })).catch(() => setLoading(false));
    }, []);
    const runAction = useCallback(async (action) => {
        const { getEmbeddingStatus, downloadLocalModel, switchToLocalMode } = await import('./embedding-status.js');
        const projectRoot = process.cwd();
        if (action === 'download') {
            setBusy('Downloading model...');
            try {
                await downloadLocalModel((pct) => setBusy(`Downloading... ${pct}%`));
                setMessage('Model downloaded');
            }
            catch (e) {
                setMessage(`Download failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        else if (action === 'rebuild') {
            setBusy('Building code embedding index...');
            try {
                const { MaestroGraph } = await import('../../graph/kg/engine.js');
                if (MaestroGraph.isInitialized(projectRoot)) {
                    const mg = await MaestroGraph.open(projectRoot);
                    try {
                        const idx = await mg.buildCodeEmbeddings();
                        setMessage(`Index built: ${idx.nodeIds.length} nodes, ${idx.dimension}d`);
                    }
                    finally {
                        mg.close();
                    }
                }
                else {
                    setMessage('KG not initialized. Run: maestro kg init');
                }
            }
            catch (e) {
                setMessage(`Build failed: ${e instanceof Error ? e.message : e}`);
            }
        }
        else if (action === 'switch') {
            if (status?.mode === 'local') {
                setMessage('To switch to API mode, create ~/.maestro/api-embedding.json');
            }
            else {
                switchToLocalMode();
                setMessage('Switched to local mode');
            }
        }
        setBusy(null);
        const newStatus = await getEmbeddingStatus(projectRoot);
        setStatus(newStatus);
    }, [status]);
    useInput((input, key) => {
        if (busy)
            return;
        if (key.escape || key.leftArrow) {
            onDone();
            return;
        }
        if (key.upArrow)
            setCursor(i => Math.max(0, i - 1));
        else if (key.downArrow)
            setCursor(i => Math.min(actions.length - 1, i + 1));
        else if (key.return || input === ' ') {
            const action = actions[cursor];
            if (action)
                runAction(action.id);
        }
        else {
            const num = parseInt(input, 10);
            if (num >= 1 && num <= actions.length) {
                setCursor(num - 1);
                runAction(actions[num - 1].id);
            }
        }
    });
    if (loading) {
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Embedding Model" }), _jsx(Text, { dimColor: true, children: "Loading..." })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: C.primary, children: "Embedding Model Management" }), status && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Mode:   " }), _jsx(Text, { bold: true, color: status.mode === 'local' ? C.success : C.accent, children: status.mode === 'local' ? 'Local (ONNX)' : 'API (External)' })] }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Model:  " }), _jsx(Text, { children: status.modelId })] }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Dim:    " }), _jsxs(Text, { children: [status.dimension, "d"] })] }), status.mode === 'local' && (_jsxs(_Fragment, { children: [_jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Cached: " }), _jsx(Text, { color: status.modelCached ? C.success : C.warning, children: status.modelCached ? 'Yes' : 'No' })] }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Device: " }), _jsxs(Text, { children: [status.device, "/", status.dtype, " batch=", status.batchSize] }), _jsx(Text, { color: status.gpuAvailable ? C.success : C.neutral, children: status.gpuAvailable ? ' (GPU)' : ' (CPU)' })] })] })), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Wiki:   " }), _jsx(Text, { children: status.wikiIndexDocs > 0 ? `${status.wikiIndexDocs} docs` : 'not built' })] }), _jsxs(Box, { children: [_jsx(Text, { dimColor: true, children: "Code:   " }), _jsx(Text, { children: status.codeIndexNodes > 0 ? `${status.codeIndexNodes} nodes` : 'not built' })] })] })), busy && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: C.warning, children: busy }) })), message && !busy && (_jsx(Box, { marginTop: 1, children: _jsx(Text, { color: C.success, children: message }) })), !busy && (_jsxs(Box, { flexDirection: "column", marginTop: 1, children: [_jsx(Text, { bold: true, children: "Actions:" }), actions.map((a, i) => (_jsxs(Box, { children: [_jsxs(Text, { color: cursor === i ? C.primary : C.neutral, children: ["[", i + 1, "]"] }), _jsxs(Text, { color: cursor === i ? C.primary : undefined, bold: cursor === i, children: [" ", a.label] })] }, a.id)))] })), _jsx(Box, { marginTop: 1, children: _jsxs(Text, { dimColor: true, children: ["[Up/Down] Navigate  [Enter/1-", actions.length, "] Run  [Esc] Back"] }) })] }));
}
//# sourceMappingURL=EmbeddingPanel.js.map