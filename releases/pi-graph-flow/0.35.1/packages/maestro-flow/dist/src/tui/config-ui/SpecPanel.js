import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import { C, SYM, SP, BORDER, pad, SectionHeader } from '../shared/index.js';
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SCOPE_LABELS = {
    project: 'Project',
    global: 'Global',
    team: 'Team',
};
const MODE_TABS = [
    { key: 'v', mode: 'view', label: 'view' },
    { key: 'b', mode: 'browse', label: 'browse' },
    { key: 'p', mode: 'preview', label: 'preview' },
    { key: 'c', mode: 'config', label: 'config' },
];
/**
 * Agent types from AGENT_CATEGORY_MAP in spec-injector — kept as a static
 * list so the panel does not import the internal constant directly.
 */
const AGENT_TYPES = [
    'code-developer',
    'tdd-developer',
    'workflow-executor',
    'universal-executor',
    'test-fix-agent',
    'cli-lite-planning-agent',
    'action-planning-agent',
    'workflow-planner',
    'workflow-reviewer',
    'debug-explore-agent',
    'workflow-debugger',
    'general',
];
// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------
export function SpecPanel({ workDir, onBack }) {
    const { exit } = useApp();
    const [mode, setMode] = useState('view');
    // Shared: scope data for View mode (loaded once)
    const [scopes, setScopes] = useState([]);
    useEffect(() => {
        loadScopeStatus();
    }, []);
    async function loadScopeStatus() {
        const { existsSync, readdirSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { resolveSpecDir } = await import('../../tools/spec-loader.js');
        const { parseSpecEntries } = await import('../../tools/spec-entry-parser.js');
        const result = [];
        for (const scope of ['project', 'global', 'team']) {
            const dir = resolveSpecDir(workDir, scope);
            const exists = existsSync(dir);
            const files = [];
            if (exists) {
                const mdFiles = readdirSync(dir).filter((f) => f.endsWith('.md'));
                for (const file of mdFiles) {
                    const content = readFileSync(join(dir, file), 'utf-8');
                    const parsed = parseSpecEntries(content);
                    const entryBriefs = parsed.entries.map(e => ({
                        title: e.title || '(untitled)',
                        keywords: e.keywords,
                    }));
                    files.push({ name: file, entries: entryBriefs.length, size: content.length, entryBriefs });
                }
            }
            result.push({ scope, exists, files });
        }
        setScopes(result);
    }
    // Mode switching input — only at top level (sub-components handle their own)
    useInput((input, key) => {
        if (input === 'q' || key.escape) {
            if (onBack)
                onBack();
            else
                exit();
            return;
        }
        for (const tab of MODE_TABS) {
            if (input === tab.key) {
                setMode(tab.mode);
                return;
            }
        }
    });
    return (_jsx(Box, { flexDirection: "column", paddingX: SP.detailPadX, children: _jsxs(Box, { ...BORDER.primary, flexDirection: "column", paddingX: SP.panelPadX, paddingY: SP.panelPadY, children: [_jsx(SectionHeader, { title: "SPEC SYSTEM" }), _jsx(Text, { children: " " }), _jsx(Box, { gap: 1, children: MODE_TABS.map(tab => (_jsx(Box, { children: mode === tab.mode
                            ? _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` [${tab.key}]${tab.label} ` })
                            : _jsx(Text, { dimColor: true, children: ` [${tab.key}]${tab.label} ` }) }, tab.mode))) }), _jsx(Text, { children: " " }), mode === 'view' && _jsx(ViewMode, { scopes: scopes }), mode === 'browse' && _jsx(BrowseMode, { workDir: workDir }), mode === 'preview' && _jsx(PreviewMode, { workDir: workDir }), mode === 'config' && _jsx(ConfigMode, { workDir: workDir }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  [v/b/p/c] mode  [q] back" })] }) }));
}
// ---------------------------------------------------------------------------
// View mode (existing behavior)
// ---------------------------------------------------------------------------
function ViewMode({ scopes }) {
    const [activeScope, setActiveScope] = useState(0);
    const [cursor, setCursor] = useState(0);
    const currentScope = scopes[activeScope];
    const fileCount = currentScope?.files.length ?? 0;
    useInput((input, key) => {
        if (key.leftArrow) {
            setActiveScope(s => Math.max(0, s - 1));
            setCursor(0);
        }
        if (key.rightArrow) {
            setActiveScope(s => Math.min(scopes.length - 1, s + 1));
            setCursor(0);
        }
        if (key.upArrow)
            setCursor(c => Math.max(0, c - 1));
        if (key.downArrow)
            setCursor(c => Math.min(fileCount - 1, c + 1));
    });
    if (scopes.length === 0) {
        return _jsx(Text, { dimColor: true, children: "Loading spec status..." });
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { gap: 1, children: scopes.map((s, i) => (_jsx(Box, { paddingX: 1, children: i === activeScope
                        ? _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` ${SCOPE_LABELS[s.scope]} ` })
                        : _jsx(Text, { dimColor: true, children: ` ${SCOPE_LABELS[s.scope]} ` }) }, s.scope))) }), _jsx(Text, { children: " " }), !currentScope.exists ? (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { color: "red", children: "  Directory not initialized" }), _jsxs(Text, { dimColor: true, children: ["  Run: maestro spec init --scope ", currentScope.scope] })] })) : currentScope.files.length === 0 ? (_jsx(Text, { dimColor: true, children: "  No spec files found" })) : (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: pad('', 2) }), _jsx(Text, { dimColor: true, bold: true, children: pad('File', 30) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Entries', 10) }), _jsx(Text, { dimColor: true, bold: true, children: "Size" })] }), currentScope.files.map((f, i) => {
                        const isCurrent = i === cursor;
                        const hasEntries = f.entries > 0;
                        return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCurrent ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { color: hasEntries ? 'green' : 'yellow', children: hasEntries ? '+' : 'o' }), _jsx(Text, { bold: isCurrent, children: pad(f.name, 29) }), _jsx(Text, { dimColor: !isCurrent, children: pad(String(f.entries), 10) }), _jsx(Text, { dimColor: true, children: formatSize(f.size) })] }, f.name));
                    })] })), currentScope?.files[cursor]?.entryBriefs.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsxs(Box, { ...BORDER.detail, flexDirection: "column", paddingX: 1, children: [_jsxs(Text, { bold: true, dimColor: true, children: ["Entries in ", currentScope.files[cursor].name, ":"] }), currentScope.files[cursor].entryBriefs.map((e, i) => (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: "green", children: "*" }), _jsx(Text, { children: truncate(e.title, 30) }), _jsxs(Text, { dimColor: true, color: "yellow", children: ["[", truncate(e.keywords.join(', '), 40), "]"] })] }, `${e.title}-${i}`)))] })] })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  ", '\u2190', "/", '\u2192', " scope  ", '\u2191', "/", '\u2193', " navigate"] }), _jsxs(Text, { dimColor: true, children: ["  CLI: maestro spec ", '<', "init|load|add|list|status", '>'] })] }));
}
// ---------------------------------------------------------------------------
// Browse mode — keyword-granularity content viewer
// ---------------------------------------------------------------------------
function BrowseMode({ workDir }) {
    const [entries, setEntries] = useState([]);
    const [cursor, setCursor] = useState(0);
    const [filterMode, setFilterMode] = useState(false);
    const [filterText, setFilterText] = useState('');
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        loadEntries();
    }, []);
    async function loadEntries() {
        const { existsSync, readdirSync, readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { resolveSpecDir } = await import('../../tools/spec-loader.js');
        const { parseSpecEntries } = await import('../../tools/spec-entry-parser.js');
        const { CATEGORY_MAP } = await import('../../tools/spec-loader.js');
        const allEntries = [];
        for (const scope of ['project', 'global', 'team']) {
            const dir = resolveSpecDir(workDir, scope);
            if (!existsSync(dir))
                continue;
            let files;
            try {
                files = readdirSync(dir).filter((f) => f.endsWith('.md'));
            }
            catch {
                continue;
            }
            for (const file of files) {
                const content = readFileSync(join(dir, file), 'utf-8');
                const parsed = parseSpecEntries(content);
                // Derive category from CATEGORY_MAP or filename
                const fileCategory = CATEGORY_MAP[file] ?? file.replace('.md', '');
                for (const entry of parsed.entries) {
                    allEntries.push({
                        title: entry.title || '(untitled)',
                        category: entry.category || fileCategory,
                        keywords: entry.keywords,
                        content: entry.content,
                    });
                }
            }
        }
        setEntries(allEntries);
        setLoading(false);
    }
    // Filter entries by keyword text
    const filtered = filterText
        ? entries.filter(e => e.keywords.some(kw => kw.toLowerCase().includes(filterText.toLowerCase())))
        : entries;
    useInput((input, key) => {
        // Filter mode: capture text
        if (filterMode) {
            if (key.escape || key.return) {
                setFilterMode(false);
                setCursor(0);
                return;
            }
            if (key.backspace || key.delete) {
                setFilterText(t => t.slice(0, -1));
                setCursor(0);
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setFilterText(t => t + input);
                setCursor(0);
                return;
            }
            return;
        }
        // Normal mode
        if (input === '/') {
            setFilterMode(true);
            setFilterText('');
            return;
        }
        if (key.upArrow)
            setCursor(c => Math.max(0, c - 1));
        if (key.downArrow)
            setCursor(c => Math.min(filtered.length - 1, c + 1));
    });
    if (loading) {
        return _jsx(Text, { dimColor: true, children: "Loading spec entries..." });
    }
    if (entries.length === 0) {
        return _jsx(Text, { dimColor: true, children: "No spec entries found across any scope." });
    }
    const selected = filtered[cursor];
    // Determine visible window for scrolling
    const MAX_VISIBLE = 12;
    const windowStart = Math.max(0, cursor - Math.floor(MAX_VISIBLE / 2));
    const visibleEntries = filtered.slice(windowStart, windowStart + MAX_VISIBLE);
    const visibleOffset = windowStart;
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Filter:" }), filterMode ? (_jsxs(Text, { color: "yellow", children: ["/", filterText, _jsx(Text, { inverse: true, children: " " })] })) : filterText ? (_jsxs(Text, { color: "green", children: ["/", filterText] })) : (_jsx(Text, { dimColor: true, children: "(press / to filter by keyword)" })), _jsxs(Text, { dimColor: true, children: ["  [", filtered.length, "/", entries.length, "]"] })] }), _jsx(Text, { children: " " }), _jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: pad('', 2) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Title', 30) }), _jsx(Text, { dimColor: true, bold: true, children: pad('Category', 12) }), _jsx(Text, { dimColor: true, bold: true, children: "Keywords" })] }), visibleEntries.map((e, i) => {
                        const realIdx = visibleOffset + i;
                        const isCurrent = realIdx === cursor;
                        return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCurrent ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { color: "green", children: "*" }), _jsx(Text, { bold: isCurrent, children: pad(truncate(e.title, 28), 29) }), _jsx(Text, { dimColor: !isCurrent, color: "yellow", children: pad(e.category, 12) }), _jsx(Text, { dimColor: true, children: truncate(e.keywords.join(', '), 40) })] }, `${e.category}-${e.title}-${realIdx}`));
                    }), filtered.length > MAX_VISIBLE && (_jsxs(Text, { dimColor: true, children: ["  ... ", filtered.length - MAX_VISIBLE, " more (scroll with arrows)"] }))] }), selected && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsxs(Box, { ...BORDER.detail, flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, color: "cyan", children: selected.title }), _jsxs(Text, { dimColor: true, children: ["[", selected.category, "] ", selected.keywords.join(', ')] }), _jsx(Text, { children: " " }), _jsx(Text, { children: truncate(selected.content.replace(/^###\s+.+\n*/m, '').trim(), 300) })] })] })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  ", '\u2191', "/", '\u2193', " navigate  [/] filter  [esc] clear filter"] })] }));
}
// ---------------------------------------------------------------------------
// Preview mode — injection preview for agent types
// ---------------------------------------------------------------------------
function PreviewMode({ workDir }) {
    const [agentIdx, setAgentIdx] = useState(0);
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const agentType = AGENT_TYPES[agentIdx];
    useEffect(() => {
        runPreview();
    }, [agentIdx]);
    async function runPreview() {
        setLoading(true);
        try {
            const { evaluateSpecInjection } = await import('../../hooks/spec-injector.js');
            const { loadSpecInjectionConfig } = await import('../../config/index.js');
            const config = loadSpecInjectionConfig(workDir);
            const res = evaluateSpecInjection(agentType, workDir, undefined, config);
            setResult(res);
        }
        catch {
            setResult({ inject: false });
        }
        setLoading(false);
    }
    useInput((_input, key) => {
        if (key.leftArrow) {
            setAgentIdx(i => (i > 0 ? i - 1 : AGENT_TYPES.length - 1));
        }
        if (key.rightArrow) {
            setAgentIdx(i => (i < AGENT_TYPES.length - 1 ? i + 1 : 0));
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: '\u2190' }), _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` ${agentType} ` }), _jsx(Text, { dimColor: true, children: '\u2192' }), _jsxs(Text, { dimColor: true, children: ["  (", agentIdx + 1, "/", AGENT_TYPES.length, ")"] })] }), _jsx(Text, { children: " " }), loading ? (_jsx(Text, { dimColor: true, children: "Evaluating injection..." })) : result ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Inject:" }), result.inject
                                ? _jsx(Text, { bold: true, color: "green", children: "yes" })
                                : _jsx(Text, { bold: true, color: "red", children: "no" })] }), result.inject && (_jsxs(_Fragment, { children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Categories:" }), _jsx(Text, { color: "yellow", children: result.categories?.join(', ') ?? '-' })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Matched entries:" }), _jsx(Text, { children: result.specCount ?? 0 })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Content size:" }), _jsx(Text, { children: formatSize(result.content?.length ?? 0) })] }), result.budgetAction && (_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Budget action:" }), _jsx(Text, { color: result.budgetAction === 'skip' ? 'red' : 'yellow', children: result.budgetAction })] }))] })), result.inject && result.content && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsxs(Box, { ...BORDER.detail, flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, dimColor: true, children: "Content preview (first 500 chars):" }), _jsx(Text, { children: truncate(result.content, 500) })] })] }))] })) : (_jsx(Text, { dimColor: true, children: "No result." })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  ", '\u2190', "/", '\u2192', " select agent type"] })] }));
}
// ---------------------------------------------------------------------------
// Config mode — interactive spec injection config editor
// ---------------------------------------------------------------------------
const ALL_CATEGORIES = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'];
const CONFIG_SECTIONS = [
    { key: '1', id: 'agents', label: 'Agent Mappings' },
    { key: '2', id: 'catdocs', label: 'Category Docs' },
    { key: '3', id: 'always', label: 'Always Inject' },
    { key: '4', id: 'filters', label: 'Global Filters' },
    { key: '5', id: 'preview', label: 'Preview' },
];
function ConfigMode({ workDir }) {
    const [config, setConfig] = useState({});
    const [loading, setLoading] = useState(true);
    const [section, setSection] = useState('agents');
    const [statusMsg, setStatusMsg] = useState('');
    useEffect(() => {
        loadConfig();
    }, []);
    async function loadConfig() {
        try {
            const { loadSpecInjectionConfig } = await import('../../config/index.js');
            const c = loadSpecInjectionConfig(workDir);
            setConfig(c);
        }
        catch {
            setConfig({});
        }
        setLoading(false);
    }
    async function persistConfig(next) {
        setConfig(next);
        try {
            const { saveSpecInjectionConfig } = await import('../../config/index.js');
            saveSpecInjectionConfig(workDir, next);
            setStatusMsg('Saved');
        }
        catch {
            setStatusMsg('Save failed');
        }
        setTimeout(() => setStatusMsg(''), 2000);
    }
    if (loading) {
        return _jsx(Text, { dimColor: true, children: "Loading config..." });
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Box, { gap: 1, children: CONFIG_SECTIONS.map(s => (_jsx(Box, { children: section === s.id
                        ? _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` [${s.key}]${s.label} ` })
                        : _jsx(Text, { dimColor: true, children: ` [${s.key}]${s.label} ` }) }, s.id))) }), _jsx(Text, { children: " " }), section === 'agents' && (_jsx(AgentMappingsSection, { config: config, onChange: persistConfig, onStatus: setStatusMsg })), section === 'catdocs' && (_jsx(CategoryDocsSection, { config: config, onChange: persistConfig, onStatus: setStatusMsg })), section === 'always' && (_jsx(AlwaysInjectSection, { config: config, onChange: persistConfig, onStatus: setStatusMsg })), section === 'filters' && (_jsx(GlobalFiltersSection, { config: config, onChange: persistConfig, onStatus: setStatusMsg })), section === 'preview' && (_jsx(ConfigPreviewSection, { workDir: workDir, config: config })), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "  [1-5] section" }), statusMsg ? _jsxs(Text, { color: "green", children: [" | ", statusMsg] }) : null] }), _jsx(ConfigSectionSwitcher, { section: section, onSwitch: setSection })] }));
}
/** Invisible component that handles 1-5 section switching at ConfigMode level. */
function ConfigSectionSwitcher({ section: _section, onSwitch, }) {
    useInput((input, _key) => {
        for (const s of CONFIG_SECTIONS) {
            if (input === s.key) {
                onSwitch(s.id);
                return;
            }
        }
    });
    return null;
}
// ---------------------------------------------------------------------------
// Section 1: Agent Mappings
// ---------------------------------------------------------------------------
function AgentMappingsSection({ config, onChange, onStatus, }) {
    const mapping = config.mapping ?? {};
    const agentNames = Object.keys(mapping);
    const [cursor, setCursor] = useState(0);
    const [expanded, setExpanded] = useState(null);
    const [subCursor, setSubCursor] = useState(0);
    const [inputMode, setInputMode] = useState('none');
    const [inputBuf, setInputBuf] = useState('');
    // For add-agent: pick from AGENT_TYPES list
    const [addAgentCursor, setAddAgentCursor] = useState(0);
    // Sub-editor rows for expanded agent
    function getSubRows(name) {
        const m = mapping[name];
        if (!m)
            return [];
        const rows = [];
        // Category toggles header
        rows.push('__categories__');
        // Include keywords
        const incl = m.includeKeywords ?? [];
        rows.push('__include_header__');
        for (const kw of incl)
            rows.push(`inc:${kw}`);
        rows.push('__include_add__');
        // Exclude keywords
        const excl = m.excludeKeywords ?? [];
        rows.push('__exclude_header__');
        for (const kw of excl)
            rows.push(`exc:${kw}`);
        rows.push('__exclude_add__');
        // Extras
        const extras = m.extras ?? [];
        rows.push('__extras_header__');
        for (const p of extras)
            rows.push(`ext:${p}`);
        rows.push('__extras_add__');
        return rows;
    }
    useInput((input, key) => {
        // --- Add agent mode: pick from AGENT_TYPES ---
        if (inputMode === 'add-agent') {
            const available = AGENT_TYPES.filter(a => !mapping[a]);
            if (key.escape) {
                setInputMode('none');
                return;
            }
            if (key.upArrow) {
                setAddAgentCursor(c => Math.max(0, c - 1));
                return;
            }
            if (key.downArrow) {
                setAddAgentCursor(c => Math.min(available.length - 1, c + 1));
                return;
            }
            if (key.return && available.length > 0) {
                const chosen = available[addAgentCursor];
                const next = { ...config, mapping: { ...mapping, [chosen]: { categories: [] } } };
                onChange(next);
                onStatus(`Added ${chosen}`);
                setInputMode('none');
            }
            return;
        }
        // --- Text input modes ---
        if (inputMode === 'add-include' || inputMode === 'add-exclude' || inputMode === 'add-extra') {
            if (key.escape) {
                setInputMode('none');
                setInputBuf('');
                return;
            }
            if (key.return && inputBuf.trim() && expanded) {
                const m = { ...(mapping[expanded] ?? { categories: [] }) };
                if (inputMode === 'add-include') {
                    m.includeKeywords = [...(m.includeKeywords ?? []), inputBuf.trim()];
                }
                else if (inputMode === 'add-exclude') {
                    m.excludeKeywords = [...(m.excludeKeywords ?? []), inputBuf.trim()];
                }
                else {
                    m.extras = [...(m.extras ?? []), inputBuf.trim()];
                }
                onChange({ ...config, mapping: { ...mapping, [expanded]: m } });
                setInputBuf('');
                setInputMode('none');
                return;
            }
            if (key.backspace || key.delete) {
                setInputBuf(b => b.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setInputBuf(b => b + input);
                return;
            }
            return;
        }
        // --- Expanded sub-editor ---
        if (expanded) {
            const rows = getSubRows(expanded);
            if (key.escape) {
                setExpanded(null);
                setSubCursor(0);
                return;
            }
            if (key.upArrow) {
                setSubCursor(c => Math.max(0, c - 1));
                return;
            }
            if (key.downArrow) {
                setSubCursor(c => Math.min(rows.length - 1, c + 1));
                return;
            }
            const currentRow = rows[subCursor];
            // Toggle category
            if (currentRow === '__categories__' && input === ' ') {
                // Noop on header; actual toggling not here
            }
            // Space on categories row: open a toggle cycle through categories
            if (currentRow === '__categories__') {
                if (key.return) {
                    // Not used here; categories shown inline
                }
            }
            // Handle [+] add rows
            if (key.return) {
                if (currentRow === '__include_add__') {
                    setInputMode('add-include');
                    setInputBuf('');
                    return;
                }
                if (currentRow === '__exclude_add__') {
                    setInputMode('add-exclude');
                    setInputBuf('');
                    return;
                }
                if (currentRow === '__extras_add__') {
                    setInputMode('add-extra');
                    setInputBuf('');
                    return;
                }
            }
            // Space toggles on categories row
            if (currentRow === '__categories__' && input) {
                const catIdx = parseInt(input, 10);
                if (catIdx >= 1 && catIdx <= ALL_CATEGORIES.length) {
                    const cat = ALL_CATEGORIES[catIdx - 1];
                    const m = { ...(mapping[expanded] ?? { categories: [] }) };
                    const cats = [...m.categories];
                    const idx = cats.indexOf(cat);
                    if (idx >= 0)
                        cats.splice(idx, 1);
                    else
                        cats.push(cat);
                    m.categories = cats;
                    onChange({ ...config, mapping: { ...mapping, [expanded]: m } });
                    return;
                }
            }
            // [d] delete on keyword/extra items
            if (input === 'd') {
                if (currentRow?.startsWith('inc:')) {
                    const kw = currentRow.slice(4);
                    const m = { ...(mapping[expanded] ?? { categories: [] }) };
                    m.includeKeywords = (m.includeKeywords ?? []).filter(k => k !== kw);
                    onChange({ ...config, mapping: { ...mapping, [expanded]: m } });
                    setSubCursor(c => Math.max(0, c - 1));
                    return;
                }
                if (currentRow?.startsWith('exc:')) {
                    const kw = currentRow.slice(4);
                    const m = { ...(mapping[expanded] ?? { categories: [] }) };
                    m.excludeKeywords = (m.excludeKeywords ?? []).filter(k => k !== kw);
                    onChange({ ...config, mapping: { ...mapping, [expanded]: m } });
                    setSubCursor(c => Math.max(0, c - 1));
                    return;
                }
                if (currentRow?.startsWith('ext:')) {
                    const p = currentRow.slice(4);
                    const m = { ...(mapping[expanded] ?? { categories: [] }) };
                    m.extras = (m.extras ?? []).filter(e => e !== p);
                    onChange({ ...config, mapping: { ...mapping, [expanded]: m } });
                    setSubCursor(c => Math.max(0, c - 1));
                    return;
                }
            }
            return;
        }
        // --- Top-level agent list ---
        if (key.upArrow) {
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(agentNames.length - 1, c + 1));
            return;
        }
        if (key.return && agentNames[cursor]) {
            setExpanded(agentNames[cursor]);
            setSubCursor(0);
            return;
        }
        if (input === 'a') {
            setInputMode('add-agent');
            setAddAgentCursor(0);
            return;
        }
        if (input === 'd' && agentNames[cursor]) {
            const name = agentNames[cursor];
            const next = { ...mapping };
            delete next[name];
            onChange({ ...config, mapping: next });
            setCursor(c => Math.max(0, c - 1));
            onStatus(`Deleted ${name}`);
            return;
        }
    });
    // --- Add agent picker overlay ---
    if (inputMode === 'add-agent') {
        const available = AGENT_TYPES.filter(a => !mapping[a]);
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: "Select agent type to add:" }), available.length === 0 ? (_jsx(Text, { dimColor: true, children: "All agent types already mapped." })) : (available.map((a, i) => (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: i === addAgentCursor ? '> ' : '  ' }), _jsx(Text, { bold: i === addAgentCursor, children: a })] }, a)))), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Enter to select, Esc to cancel" })] }));
    }
    // --- Text input overlay ---
    if (inputMode === 'add-include' || inputMode === 'add-exclude' || inputMode === 'add-extra') {
        const label = inputMode === 'add-include' ? 'include keyword'
            : inputMode === 'add-exclude' ? 'exclude keyword'
                : 'extra doc path';
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Add ", label, ":"] }), _jsxs(Text, { color: "yellow", children: [inputBuf, _jsx(Text, { inverse: true, children: " " })] })] }), _jsx(Text, { dimColor: true, children: "  Enter to confirm, Esc to cancel" })] }));
    }
    // --- Expanded agent sub-editor ---
    if (expanded) {
        const m = mapping[expanded] ?? { categories: [] };
        const rows = getSubRows(expanded);
        const incl = m.includeKeywords ?? [];
        const excl = m.excludeKeywords ?? [];
        const extras = m.extras ?? [];
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: expanded }), _jsx(Text, { children: " " }), rows.map((row, i) => {
                    const isCur = i === subCursor;
                    const prefix = isCur ? '> ' : '  ';
                    if (row === '__categories__') {
                        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Text, { bold: isCur, children: [prefix, "Categories (press 1-7 to toggle):"] }), _jsx(Box, { paddingLeft: 4, gap: 1, flexWrap: "wrap", children: ALL_CATEGORIES.map((cat, ci) => {
                                        const on = m.categories.includes(cat);
                                        return (_jsx(Text, { color: on ? 'green' : 'gray', children: `[${on ? 'x' : ' '}]${ci + 1}:${cat}` }, cat));
                                    }) })] }, "cats"));
                    }
                    if (row === '__include_header__') {
                        return _jsxs(Text, { dimColor: true, children: [prefix, "Include keywords (", incl.length, "):"] }, "inh");
                    }
                    if (row === '__exclude_header__') {
                        return _jsxs(Text, { dimColor: true, children: [prefix, "Exclude keywords (", excl.length, "):"] }, "exh");
                    }
                    if (row === '__extras_header__') {
                        return _jsxs(Text, { dimColor: true, children: [prefix, "Extras (", extras.length, "):"] }, "exth");
                    }
                    if (row === '__include_add__' || row === '__exclude_add__' || row === '__extras_add__') {
                        return _jsxs(Text, { color: isCur ? 'yellow' : 'gray', children: [prefix, "[+] add"] }, row);
                    }
                    if (row.startsWith('inc:')) {
                        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: prefix }), _jsx(Text, { color: "green", bold: isCur, children: row.slice(4) }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `i-${row}`));
                    }
                    if (row.startsWith('exc:')) {
                        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: prefix }), _jsx(Text, { color: "red", bold: isCur, children: row.slice(4) }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `e-${row}`));
                    }
                    if (row.startsWith('ext:')) {
                        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: prefix }), _jsx(Text, { bold: isCur, children: row.slice(4) }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `x-${row}`));
                    }
                    return null;
                }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Esc back | Enter expand | 1-7 toggle cat | d delete" })] }));
    }
    // --- Agent list ---
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Agent Mappings" }), _jsx(Text, { children: " " }), agentNames.length === 0 ? (_jsx(Text, { dimColor: true, children: "No agent mappings configured. Press [a] to add." })) : (agentNames.map((name, i) => {
                const m = mapping[name];
                const isCur = i === cursor;
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCur ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { bold: isCur, children: pad(name, 25) }), _jsx(Box, { gap: 1, children: m.categories.map(c => (_jsx(Text, { color: "yellow", children: c }, c))) }), _jsx(Text, { dimColor: true, children: ` kw:${(m.includeKeywords?.length ?? 0) + (m.excludeKeywords?.length ?? 0)}` })] }, name));
            })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Enter expand | [a]dd | [d]el | Up/Down navigate" })] }));
}
// ---------------------------------------------------------------------------
// Section 2: Category Docs
// ---------------------------------------------------------------------------
function CategoryDocsSection({ config, onChange, onStatus, }) {
    const catDocs = config.categoryDocs ?? {};
    const [cursor, setCursor] = useState(0);
    const [expanded, setExpanded] = useState(null);
    const [subCursor, setSubCursor] = useState(0);
    const [inputMode, setInputMode] = useState('none');
    const [inputBuf, setInputBuf] = useState('');
    function getSubRows(cat) {
        const cd = catDocs[cat];
        const rows = [];
        rows.push('__specs_header__');
        for (const f of cd?.specFiles ?? [])
            rows.push(`spec:${f}`);
        rows.push('__specs_add__');
        rows.push('__docs_header__');
        for (const d of cd?.docs ?? [])
            rows.push(`doc:${d}`);
        rows.push('__docs_add__');
        return rows;
    }
    useInput((input, key) => {
        // Text input
        if (inputMode === 'add-spec' || inputMode === 'add-doc') {
            if (key.escape) {
                setInputMode('none');
                setInputBuf('');
                return;
            }
            if (key.return && inputBuf.trim() && expanded) {
                const cd = { ...(catDocs[expanded] ?? {}) };
                if (inputMode === 'add-spec') {
                    cd.specFiles = [...(cd.specFiles ?? []), inputBuf.trim()];
                }
                else {
                    cd.docs = [...(cd.docs ?? []), inputBuf.trim()];
                }
                onChange({ ...config, categoryDocs: { ...catDocs, [expanded]: cd } });
                setInputBuf('');
                setInputMode('none');
                return;
            }
            if (key.backspace || key.delete) {
                setInputBuf(b => b.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setInputBuf(b => b + input);
                return;
            }
            return;
        }
        // Expanded sub-editor
        if (expanded) {
            const rows = getSubRows(expanded);
            if (key.escape) {
                setExpanded(null);
                setSubCursor(0);
                return;
            }
            if (key.upArrow) {
                setSubCursor(c => Math.max(0, c - 1));
                return;
            }
            if (key.downArrow) {
                setSubCursor(c => Math.min(rows.length - 1, c + 1));
                return;
            }
            const currentRow = rows[subCursor];
            if (key.return) {
                if (currentRow === '__specs_add__') {
                    setInputMode('add-spec');
                    setInputBuf('');
                    return;
                }
                if (currentRow === '__docs_add__') {
                    setInputMode('add-doc');
                    setInputBuf('');
                    return;
                }
            }
            if (input === 'd') {
                if (currentRow?.startsWith('spec:')) {
                    const f = currentRow.slice(5);
                    const cd = { ...(catDocs[expanded] ?? {}) };
                    cd.specFiles = (cd.specFiles ?? []).filter(s => s !== f);
                    onChange({ ...config, categoryDocs: { ...catDocs, [expanded]: cd } });
                    setSubCursor(c => Math.max(0, c - 1));
                    return;
                }
                if (currentRow?.startsWith('doc:')) {
                    const d = currentRow.slice(4);
                    const cd = { ...(catDocs[expanded] ?? {}) };
                    cd.docs = (cd.docs ?? []).filter(x => x !== d);
                    onChange({ ...config, categoryDocs: { ...catDocs, [expanded]: cd } });
                    setSubCursor(c => Math.max(0, c - 1));
                    return;
                }
            }
            return;
        }
        // Top-level category list
        if (key.upArrow) {
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(ALL_CATEGORIES.length - 1, c + 1));
            return;
        }
        if (key.return) {
            const cat = ALL_CATEGORIES[cursor];
            setExpanded(cat);
            setSubCursor(0);
            return;
        }
        if (input === 'd' && ALL_CATEGORIES[cursor]) {
            const cat = ALL_CATEGORIES[cursor];
            if (catDocs[cat]) {
                const next = { ...catDocs };
                delete next[cat];
                onChange({ ...config, categoryDocs: next });
                onStatus(`Cleared docs for ${cat}`);
            }
            return;
        }
    });
    // Text input overlay
    if (inputMode === 'add-spec' || inputMode === 'add-doc') {
        const label = inputMode === 'add-spec' ? 'spec file' : 'doc path';
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Add ", label, " to ", expanded, ":"] }), _jsxs(Text, { color: "yellow", children: [inputBuf, _jsx(Text, { inverse: true, children: " " })] })] }), _jsx(Text, { dimColor: true, children: "  Enter to confirm, Esc to cancel" })] }));
    }
    // Expanded sub-editor
    if (expanded) {
        const cd = catDocs[expanded] ?? {};
        const rows = getSubRows(expanded);
        const specs = cd.specFiles ?? [];
        const docs = cd.docs ?? [];
        return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, color: "cyan", children: expanded }), _jsx(Text, { children: " " }), rows.map((row, i) => {
                    const isCur = i === subCursor;
                    const prefix = isCur ? '> ' : '  ';
                    if (row === '__specs_header__') {
                        return _jsxs(Text, { dimColor: true, children: [prefix, "Spec files (", specs.length, "):"] }, "sh");
                    }
                    if (row === '__docs_header__') {
                        return _jsxs(Text, { dimColor: true, children: [prefix, "Doc paths (", docs.length, "):"] }, "dh");
                    }
                    if (row === '__specs_add__' || row === '__docs_add__') {
                        return _jsxs(Text, { color: isCur ? 'yellow' : 'gray', children: [prefix, "[+] add"] }, row);
                    }
                    if (row.startsWith('spec:')) {
                        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: prefix }), _jsx(Text, { bold: isCur, children: row.slice(5) }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `s-${row}`));
                    }
                    if (row.startsWith('doc:')) {
                        return (_jsxs(Box, { children: [_jsx(Text, { color: "cyan", children: prefix }), _jsx(Text, { bold: isCur, children: row.slice(4) }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `d-${row}`));
                    }
                    return null;
                }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Esc back | Enter add | d delete" })] }));
    }
    // Category list
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Category Docs" }), _jsx(Text, { children: " " }), ALL_CATEGORIES.map((cat, i) => {
                const isCur = i === cursor;
                const cd = catDocs[cat];
                const hasData = cd && ((cd.specFiles?.length ?? 0) + (cd.docs?.length ?? 0) > 0);
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCur ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { bold: isCur, color: hasData ? 'green' : undefined, children: pad(cat, 12) }), hasData ? (_jsxs(Text, { dimColor: true, children: ["specs:", cd.specFiles?.length ?? 0, " docs:", cd.docs?.length ?? 0] })) : (_jsx(Text, { dimColor: true, children: "-" }))] }, cat));
            }), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Enter expand | [d]el docs | Up/Down navigate" })] }));
}
// ---------------------------------------------------------------------------
// Section 3: Always Inject
// ---------------------------------------------------------------------------
function AlwaysInjectSection({ config, onChange, onStatus: _onStatus, }) {
    const always = config.always ?? {};
    const TABS = ['docs', 'keywords', 'categories'];
    const [tab, setTab] = useState('docs');
    const [cursor, setCursor] = useState(0);
    const [inputMode, setInputMode] = useState(false);
    const [inputBuf, setInputBuf] = useState('');
    const currentList = always[tab] ?? [];
    useInput((input, key) => {
        if (inputMode) {
            if (key.escape) {
                setInputMode(false);
                setInputBuf('');
                return;
            }
            if (key.return && inputBuf.trim()) {
                const updated = { ...always, [tab]: [...currentList, inputBuf.trim()] };
                onChange({ ...config, always: updated });
                setInputBuf('');
                setInputMode(false);
                return;
            }
            if (key.backspace || key.delete) {
                setInputBuf(b => b.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setInputBuf(b => b + input);
                return;
            }
            return;
        }
        if (key.tab) {
            const idx = TABS.indexOf(tab);
            setTab(TABS[(idx + 1) % TABS.length]);
            setCursor(0);
            return;
        }
        if (key.upArrow) {
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(currentList.length - 1, c + 1));
            return;
        }
        if (input === 'a') {
            setInputMode(true);
            setInputBuf('');
            return;
        }
        if (input === 'd' && currentList[cursor]) {
            const next = currentList.filter((_, i) => i !== cursor);
            const updated = { ...always, [tab]: next.length > 0 ? next : undefined };
            onChange({ ...config, always: updated });
            setCursor(c => Math.max(0, c - 1));
            return;
        }
    });
    if (inputMode) {
        const hint = tab === 'docs' ? 'doc path' : tab === 'keywords' ? 'keyword' : 'category';
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Add ", hint, ":"] }), _jsxs(Text, { color: "yellow", children: [inputBuf, _jsx(Text, { inverse: true, children: " " })] })] }), _jsx(Text, { dimColor: true, children: "  Enter to confirm, Esc to cancel" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Always Inject (session start)" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [TABS.map(t => (_jsx(Box, { children: t === tab
                            ? _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` ${t} ` })
                            : _jsx(Text, { dimColor: true, children: ` ${t} ` }) }, t))), _jsx(Text, { dimColor: true, children: "(Tab to switch)" })] }), _jsx(Text, { children: " " }), currentList.length === 0 ? (_jsxs(Text, { dimColor: true, children: ["No ", tab, " configured. Press [a] to add."] })) : (currentList.map((p, i) => {
                const isCur = i === cursor;
                const color = tab === 'keywords' ? 'green' : tab === 'categories' ? 'yellow' : undefined;
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCur ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { bold: isCur, color: color, children: p }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `${p}-${i}`));
            })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  [a]dd | [d]el | Tab switch | Up/Down navigate" })] }));
}
// ---------------------------------------------------------------------------
// Section 4: Global Filters
// ---------------------------------------------------------------------------
function GlobalFiltersSection({ config, onChange, onStatus: _onStatus, }) {
    const filters = config.keywordFilters ?? {};
    const includeKw = filters.include ?? [];
    const excludeKw = filters.exclude ?? [];
    const [activeList, setActiveList] = useState('include');
    const [cursor, setCursor] = useState(0);
    const [inputMode, setInputMode] = useState(false);
    const [inputBuf, setInputBuf] = useState('');
    const currentList = activeList === 'include' ? includeKw : excludeKw;
    useInput((input, key) => {
        if (inputMode) {
            if (key.escape) {
                setInputMode(false);
                setInputBuf('');
                return;
            }
            if (key.return && inputBuf.trim()) {
                const f = { ...filters };
                if (activeList === 'include') {
                    f.include = [...includeKw, inputBuf.trim()];
                }
                else {
                    f.exclude = [...excludeKw, inputBuf.trim()];
                }
                onChange({ ...config, keywordFilters: f });
                setInputBuf('');
                setInputMode(false);
                return;
            }
            if (key.backspace || key.delete) {
                setInputBuf(b => b.slice(0, -1));
                return;
            }
            if (input && !key.ctrl && !key.meta) {
                setInputBuf(b => b + input);
                return;
            }
            return;
        }
        if (key.tab) {
            setActiveList(l => l === 'include' ? 'exclude' : 'include');
            setCursor(0);
            return;
        }
        if (key.upArrow) {
            setCursor(c => Math.max(0, c - 1));
            return;
        }
        if (key.downArrow) {
            setCursor(c => Math.min(currentList.length - 1, c + 1));
            return;
        }
        if (input === 'a') {
            setInputMode(true);
            setInputBuf('');
            return;
        }
        if (input === 'd' && currentList[cursor]) {
            const f = { ...filters };
            if (activeList === 'include') {
                f.include = includeKw.filter((_, i) => i !== cursor);
            }
            else {
                f.exclude = excludeKw.filter((_, i) => i !== cursor);
            }
            onChange({ ...config, keywordFilters: f });
            setCursor(c => Math.max(0, c - 1));
            return;
        }
    });
    if (inputMode) {
        const label = activeList === 'include' ? 'include keyword' : 'exclude keyword';
        return (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsxs(Text, { bold: true, color: "cyan", children: ["Add ", label, ":"] }), _jsxs(Text, { color: "yellow", children: [inputBuf, _jsx(Text, { inverse: true, children: " " })] })] }), _jsx(Text, { dimColor: true, children: "  Enter to confirm, Esc to cancel" })] }));
    }
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Global Filters" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 2, children: [_jsx(Text, { bold: activeList === 'include', inverse: activeList === 'include', color: "green", children: ' Include ' }), _jsx(Text, { bold: activeList === 'exclude', inverse: activeList === 'exclude', color: "red", children: ' Exclude ' }), _jsx(Text, { dimColor: true, children: "(Tab to switch)" })] }), _jsx(Text, { children: " " }), currentList.length === 0 ? (_jsxs(Text, { dimColor: true, children: ["No ", activeList, " keywords. Press [a] to add."] })) : (currentList.map((kw, i) => {
                const isCur = i === cursor;
                return (_jsxs(Box, { gap: 1, children: [_jsx(Text, { color: C.primary, children: isCur ? SYM.cursor : SYM.cursorBlank }), _jsx(Text, { bold: isCur, color: activeList === 'include' ? 'green' : 'red', children: kw }), isCur && _jsx(Text, { dimColor: true, children: " [d]del" })] }, `${kw}-${i}`));
            })), _jsx(Text, { children: " " }), _jsx(Text, { dimColor: true, children: "  Tab switch | [a]dd | [d]el | Up/Down navigate" })] }));
}
// ---------------------------------------------------------------------------
// Section 5: Config Preview (reuses PreviewMode logic)
// ---------------------------------------------------------------------------
function ConfigPreviewSection({ workDir, config, }) {
    const [agentIdx, setAgentIdx] = useState(0);
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const agentType = AGENT_TYPES[agentIdx];
    useEffect(() => {
        runPreview();
    }, [agentIdx, config]);
    async function runPreview() {
        setLoading(true);
        try {
            const { evaluateSpecInjection } = await import('../../hooks/spec-injector.js');
            const res = evaluateSpecInjection(agentType, workDir, undefined, config);
            setResult(res);
        }
        catch {
            setResult({ inject: false });
        }
        setLoading(false);
    }
    useInput((_input, key) => {
        if (key.leftArrow) {
            setAgentIdx(i => (i > 0 ? i - 1 : AGENT_TYPES.length - 1));
        }
        if (key.rightArrow) {
            setAgentIdx(i => (i < AGENT_TYPES.length - 1 ? i + 1 : 0));
        }
    });
    return (_jsxs(Box, { flexDirection: "column", children: [_jsx(Text, { bold: true, children: "Preview (live from current config)" }), _jsx(Text, { children: " " }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: '\u2190' }), _jsx(Text, { bold: true, inverse: true, color: "cyan", children: ` ${agentType} ` }), _jsx(Text, { dimColor: true, children: '\u2192' }), _jsxs(Text, { dimColor: true, children: ["  (", agentIdx + 1, "/", AGENT_TYPES.length, ")"] })] }), _jsx(Text, { children: " " }), loading ? (_jsx(Text, { dimColor: true, children: "Evaluating injection..." })) : result ? (_jsxs(Box, { flexDirection: "column", children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Inject:" }), result.inject
                                ? _jsx(Text, { bold: true, color: "green", children: "yes" })
                                : _jsx(Text, { bold: true, color: "red", children: "no" })] }), result.inject && (_jsxs(_Fragment, { children: [_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Categories:" }), _jsx(Text, { color: "yellow", children: result.categories?.join(', ') ?? '-' })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Matched entries:" }), _jsx(Text, { children: result.specCount ?? 0 })] }), _jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Content size:" }), _jsx(Text, { children: formatSize(result.content?.length ?? 0) })] }), result.budgetAction && (_jsxs(Box, { gap: 1, children: [_jsx(Text, { dimColor: true, children: "Budget action:" }), _jsx(Text, { color: result.budgetAction === 'skip' ? 'red' : 'yellow', children: result.budgetAction })] }))] })), result.inject && result.content && (_jsxs(_Fragment, { children: [_jsx(Text, { children: " " }), _jsxs(Box, { ...BORDER.detail, flexDirection: "column", paddingX: 1, children: [_jsx(Text, { bold: true, dimColor: true, children: "Content preview (first 500 chars):" }), _jsx(Text, { children: truncate(result.content, 500) })] })] }))] })) : (_jsx(Text, { dimColor: true, children: "No result." })), _jsx(Text, { children: " " }), _jsxs(Text, { dimColor: true, children: ["  ", '\u2190', "/", '\u2192', " select agent type"] })] }));
}
// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------
function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}
function truncate(s, maxLen) {
    if (s.length <= maxLen)
        return s;
    return s.slice(0, maxLen - 3) + '...';
}
//# sourceMappingURL=SpecPanel.js.map