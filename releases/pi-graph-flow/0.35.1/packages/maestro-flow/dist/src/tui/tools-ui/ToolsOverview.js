import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { saveCliToolsConfig, DOMAIN_TAGS, REASONING_EFFORTS, } from '../../config/cli-tools-config.js';
import { pad, wrapCursor } from '../shared/index.js';
export function ToolsOverview({ config, workDir, onBack, onReload }) {
    const entries = Object.entries(config.tools);
    const [cursor, setCursor] = useState(0);
    const [mode, setMode] = useState('list');
    const [tagCursor, setTagCursor] = useState(0);
    const [editTags, setEditTags] = useState([]);
    const [effortCursor, setEffortCursor] = useState(0);
    const [saving, setSaving] = useState(false);
    const [settingsError, setSettingsError] = useState('');
    useInput((input, key) => {
        if (saving)
            return;
        if (mode === 'list') {
            if (key.escape) {
                onBack();
                return;
            }
            if (key.upArrow)
                setCursor(c => wrapCursor(c, -1, entries.length));
            if (key.downArrow)
                setCursor(c => wrapCursor(c, 1, entries.length));
            if (input === 't' && entries.length > 0) {
                // Enter tag editing for current tool
                setEditTags([...(entries[cursor][1].tags ?? [])]);
                setTagCursor(0);
                setMode('edit-tags');
            }
            if (input === 's' && entries.length > 0) {
                // Enter settingsFile editing for current tool
                setSettingsError('');
                setMode('edit-settings');
            }
            if (input === 'e' && entries.length > 0) {
                // Enter reasoning effort editing for current tool
                const current = entries[cursor][1].reasoningEffort;
                // effortOptions: [undefined, ...REASONING_EFFORTS] — index 0 = default (unset)
                const idx = current ? REASONING_EFFORTS.indexOf(current) + 1 : 0;
                setEffortCursor(idx);
                setMode('edit-effort');
            }
            if (input === ' ' && entries.length > 0) {
                // Toggle enabled
                const [name, entry] = entries[cursor];
                setSaving(true);
                saveCliToolsConfig({ tools: { [name]: { ...entry, enabled: !entry.enabled } } }, 'global', workDir)
                    .then(() => { onReload(); setSaving(false); });
            }
        }
        if (mode === 'edit-tags') {
            if (key.escape) {
                setMode('list');
                return;
            }
            if (key.upArrow)
                setTagCursor(c => c > 0 ? c - 1 : DOMAIN_TAGS.length - 1);
            if (key.downArrow)
                setTagCursor(c => c < DOMAIN_TAGS.length - 1 ? c + 1 : 0);
            if (input === ' ' || key.return) {
                const tag = DOMAIN_TAGS[tagCursor];
                setEditTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
            }
            if (input === 's') {
                // Save tags
                const [name, entry] = entries[cursor];
                setSaving(true);
                saveCliToolsConfig({ tools: { [name]: { ...entry, tags: editTags } } }, 'global', workDir)
                    .then(() => { onReload(); setSaving(false); setMode('list'); });
            }
        }
        if (mode === 'edit-effort') {
            const optionCount = REASONING_EFFORTS.length + 1; // +1 for "default" (unset)
            if (key.escape) {
                setMode('list');
                return;
            }
            if (key.upArrow)
                setEffortCursor(c => c > 0 ? c - 1 : optionCount - 1);
            if (key.downArrow)
                setEffortCursor(c => c < optionCount - 1 ? c + 1 : 0);
            if (key.return || input === ' ') {
                const [name, entry] = entries[cursor];
                const newEffort = effortCursor === 0 ? undefined : REASONING_EFFORTS[effortCursor - 1];
                // Build updated entry — explicitly remove reasoningEffort when set to default
                const updated = { ...entry };
                if (newEffort) {
                    updated.reasoningEffort = newEffort;
                }
                else {
                    delete updated.reasoningEffort;
                }
                setSaving(true);
                saveCliToolsConfig({ tools: { [name]: updated } }, 'global', workDir)
                    .then(() => { onReload(); setSaving(false); setMode('list'); });
            }
        }
        if (mode === 'edit-settings') {
            if (key.escape) {
                setSettingsError('');
                setMode('list');
                return;
            }
        }
    });
    const handleSettingsSubmit = (value) => {
        const [name, entry] = entries[cursor];
        const newPath = value.trim() || undefined;
        setSaving(true);
        saveCliToolsConfig({ tools: { [name]: { ...entry, settingsFile: newPath } } }, 'global', workDir)
            .then(() => { onReload(); setSaving(false); setMode('list'); })
            .catch((err) => {
            setSettingsError(err instanceof Error ? err.message : String(err));
            setSaving(false);
        });
    };
    if (entries.length === 0) {
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "Tools Overview" }), _jsx(Text, { dimColor: true, children: "No tools configured." }), _jsx(Text, { dimColor: true, children: "[Esc] Back" })] }));
    }
    if (mode === 'edit-tags') {
        const [name] = entries[cursor];
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Edit Tags: ", _jsx(Text, { color: "green", children: name })] }), _jsx(Text, { children: " " }), DOMAIN_TAGS.map((tag, i) => {
                    const selected = editTags.includes(tag);
                    const active = i === tagCursor;
                    return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: active ? 'cyan' : undefined, children: [active ? '▸' : ' ', " ", selected ? '[✓]' : '[ ]'] }), _jsx(Text, { bold: active, color: active ? 'cyan' : selected ? 'green' : undefined, children: tag })] }, tag));
                }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [Space] Toggle  [s] Save  [Esc] Cancel" })] }));
    }
    if (mode === 'edit-effort') {
        const [name] = entries[cursor];
        const effortOptions = [
            { label: 'default (unset)', value: undefined },
            ...REASONING_EFFORTS.map(e => ({ label: e, value: e })),
        ];
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Reasoning Effort: ", _jsx(Text, { color: "green", children: name })] }), _jsx(Text, { children: " " }), effortOptions.map((opt, i) => {
                    const active = i === effortCursor;
                    return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: active ? 'cyan' : undefined, children: active ? '▸' : ' ' }), _jsx(Text, { bold: active, color: active ? 'cyan' : undefined, children: opt.label })] }, opt.label));
                }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [Enter/Space] Select  [Esc] Cancel" }), saving && _jsx(Text, { dimColor: true, children: "Saving..." })] }));
    }
    if (mode === 'edit-settings') {
        const [name, entry] = entries[cursor];
        return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Edit Settings: ", _jsx(Text, { color: "green", children: name })] }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { children: "Settings file:" }), _jsx(TextInput, { defaultValue: entry.settingsFile ?? '', placeholder: "~/.maestro/profiles/settings.json (empty to clear)", onSubmit: handleSettingsSubmit })] }), settingsError && _jsxs(Text, { color: "red", children: ["  ", settingsError] }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[Enter] Save  [Esc] Cancel" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: "Tools Overview" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsxs(Text, { dimColor: true, children: ['  ', pad('Tool', 12)] }), _jsx(Text, { dimColor: true, children: pad('Model', 24) }), _jsx(Text, { dimColor: true, children: pad('Effort', 8) }), _jsx(Text, { dimColor: true, children: pad('Tags', 24) }), _jsx(Text, { dimColor: true, children: "Settings" })] }), _jsx(Text, { dimColor: true, children: '  ' + '─'.repeat(80) }), entries.map(([name, entry], i) => {
                const active = i === cursor;
                const color = active ? 'cyan' : undefined;
                const statusIcon = entry.enabled ? '✓' : '✗';
                const statusColor = entry.enabled ? 'green' : 'red';
                const effort = entry.reasoningEffort ?? '—';
                const tags = entry.tags?.length ? entry.tags.join(', ') : '—';
                const settings = entry.settingsFile || '—';
                return (_jsxs(Box, { gap: 1, children: [_jsxs(Text, { color: statusColor, children: [active ? '▸' : ' ', statusIcon] }), _jsx(Text, { bold: active, color: color, children: pad(name, 12) }), _jsx(Text, { color: color, children: pad(entry.primaryModel || '—', 24) }), _jsx(Text, { color: "magenta", children: pad(effort, 8) }), _jsx(Text, { color: "yellow", children: pad(tags, 24) }), _jsx(Text, { dimColor: !entry.settingsFile, children: settings })] }, name));
            }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "[\u2191\u2193] Navigate  [Space] Toggle  [t] Tags  [e] Effort  [s] Settings  [Esc] Back" }), saving && _jsx(Text, { dimColor: true, children: "Saving..." })] }));
}
//# sourceMappingURL=ToolsOverview.js.map