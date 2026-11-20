import { readFile, writeFile, readdir, stat, access, constants, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Hono } from 'hono';
// ---------------------------------------------------------------------------
// Settings routes — config file read/write
// ---------------------------------------------------------------------------
/** Paths for settings files */
function getConfigPaths(workflowRoot) {
    return {
        cliTools: resolve(homedir(), '.maestro', 'cli-tools.json'),
        searchTool: resolve(homedir(), '.maestro', 'templates', 'search-tool.json'),
        dashboardConfig: resolve(workflowRoot, 'config.json'),
        specDir: resolve(workflowRoot, 'blueprint'),
    };
}
export function createSettingsRoutes(workflowRoot) {
    const app = new Hono();
    const getPaths = () => getConfigPaths(typeof workflowRoot === 'function' ? workflowRoot() : workflowRoot);
    // Startup-only paths for initial LINEAR_API_KEY load
    const paths = getPaths();
    // Load LINEAR_API_KEY from config at startup
    void (async () => {
        try {
            const raw = await readFile(paths.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            const settings = json['settings'];
            const linear = settings?.['linear'];
            const apiKey = typeof linear?.['apiKey'] === 'string' ? linear['apiKey'] : '';
            if (apiKey && !process.env.LINEAR_API_KEY) {
                process.env.LINEAR_API_KEY = apiKey;
            }
        }
        catch {
            // Config not found — skip
        }
    })();
    // -----------------------------------------------------------------------
    // GET /api/settings — read all config
    // -----------------------------------------------------------------------
    app.get('/api/settings', async (c) => {
        const p = getPaths();
        const result = {
            general: { theme: 'system', language: 'en' },
            agents: {},
            cliTools: '{}',
        };
        // Read dashboard config
        try {
            const raw = await readFile(p.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            if (json['settings']) {
                const settings = json['settings'];
                if (settings['general'])
                    result['general'] = settings['general'];
                if (settings['agents'])
                    result['agents'] = settings['agents'];
            }
        }
        catch {
            // Config file missing — use defaults
        }
        // Read cli-tools.json
        try {
            const raw = await readFile(p.cliTools, 'utf-8');
            // Validate it's valid JSON
            JSON.parse(raw);
            result['cliTools'] = raw;
        }
        catch {
            result['cliTools'] = '{}';
        }
        // Read search tool config
        try {
            const raw = await readFile(p.searchTool, 'utf-8');
            const json = JSON.parse(raw);
            result['searchTool'] = typeof json['name'] === 'string' ? json['name'] : 'mcp__ace-tool__search_context';
        }
        catch {
            result['searchTool'] = 'mcp__ace-tool__search_context';
        }
        // Read linear settings
        try {
            const raw = await readFile(p.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            if (json['settings']) {
                const settings = json['settings'];
                if (settings['linear']) {
                    const linear = settings['linear'];
                    const apiKey = typeof linear['apiKey'] === 'string' ? linear['apiKey'] : '';
                    result['linear'] = {
                        apiKey: apiKey ? `${apiKey.slice(0, 8)}...${apiKey.slice(-4)}` : '',
                        configured: !!apiKey,
                    };
                }
            }
        }
        catch {
            // Already handled above
        }
        if (!result['linear']) {
            result['linear'] = { apiKey: '', configured: false };
        }
        // Read commander config (top-level `commander` key in config.json, Layer 3)
        try {
            const raw = await readFile(p.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            if (json['commander'] && typeof json['commander'] === 'object') {
                result['commander'] = json['commander'];
            }
        }
        catch {
            // No commander config — client will use defaults
        }
        return c.json(result);
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/general — write dashboard general config
    // -----------------------------------------------------------------------
    app.put('/api/settings/general', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            // Read existing config
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            // Merge settings
            const settings = (config['settings'] ?? {});
            settings['general'] = body;
            config['settings'] = settings;
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/agents — write agent config
    // -----------------------------------------------------------------------
    app.put('/api/settings/agents', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            const settings = (config['settings'] ?? {});
            settings['agents'] = body;
            config['settings'] = settings;
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/cli-tools — write cli-tools.json
    // -----------------------------------------------------------------------
    app.put('/api/settings/cli-tools', async (c) => {
        try {
            const p = getPaths();
            const body = (await c.req.json());
            const content = body.content;
            // Validate JSON structure
            const parsed = JSON.parse(content);
            if (typeof parsed !== 'object' || parsed === null) {
                return c.json({ ok: false, error: 'Invalid JSON: must be an object' }, 400);
            }
            // Check write permission
            try {
                await access(p.cliTools, constants.W_OK);
            }
            catch {
                return c.json({ ok: false, error: 'Cannot write to cli-tools.json: file is read-only or inaccessible' }, 403);
            }
            await writeFile(p.cliTools, JSON.stringify(parsed, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            if (message.includes('JSON')) {
                return c.json({ ok: false, error: `Invalid JSON: ${message}` }, 400);
            }
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/linear — write Linear API Key
    // -----------------------------------------------------------------------
    app.put('/api/settings/linear', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            const settings = (config['settings'] ?? {});
            settings['linear'] = { apiKey };
            config['settings'] = settings;
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            // Also set the env var so linear routes pick it up immediately
            if (apiKey) {
                process.env.LINEAR_API_KEY = apiKey;
            }
            else {
                delete process.env.LINEAR_API_KEY;
            }
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/commander — write commander config to top-level key
    // -----------------------------------------------------------------------
    app.put('/api/settings/commander', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            config['commander'] = body;
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // GET /api/settings/search-tool — read ~/.maestro/templates/search-tool.json
    // -----------------------------------------------------------------------
    app.get('/api/settings/search-tool', async (c) => {
        const p = getPaths();
        try {
            const raw = await readFile(p.searchTool, 'utf-8');
            const json = JSON.parse(raw);
            return c.json({
                name: typeof json['name'] === 'string' ? json['name'] : 'mcp__ace-tool__search_context',
            });
        }
        catch {
            return c.json({ name: 'mcp__ace-tool__search_context' });
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/search-tool — write ~/.maestro/templates/search-tool.json
    // -----------------------------------------------------------------------
    app.put('/api/settings/search-tool', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name) {
                return c.json({ ok: false, error: 'Search tool name cannot be empty' }, 400);
            }
            // Ensure ~/.maestro/templates/ directory exists
            const templatesDir = resolve(homedir(), '.maestro', 'templates');
            try {
                await access(templatesDir, constants.F_OK);
            }
            catch {
                await mkdir(templatesDir, { recursive: true });
            }
            await writeFile(p.searchTool, JSON.stringify({ name }, null, 2) + '\n', 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // GET /api/settings/specs — list .workflow/blueprint/ directories
    // -----------------------------------------------------------------------
    app.get('/api/settings/specs', async (c) => {
        try {
            const p = getPaths();
            const entries = await readdir(p.specDir, { withFileTypes: true }).catch(() => []);
            const specs = [];
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const fullPath = join(p.specDir, entry.name);
                    let createdAt;
                    try {
                        const info = await stat(fullPath);
                        createdAt = info.birthtime.toISOString();
                    }
                    catch {
                        // Skip stat errors
                    }
                    specs.push({
                        name: entry.name,
                        path: `.workflow/blueprint/${entry.name}`,
                        createdAt,
                    });
                }
            }
            // Sort by name descending (newest date-based names first)
            specs.sort((a, b) => b.name.localeCompare(a.name));
            return c.json({ specs });
        }
        catch {
            return c.json({ specs: [] });
        }
    });
    // -----------------------------------------------------------------------
    // GET /api/language/chinese-response — check status
    // -----------------------------------------------------------------------
    app.get('/api/language/chinese-response', async (c) => {
        try {
            const userClaudePath = join(homedir(), '.claude', 'CLAUDE.md');
            const userCodexPath = join(homedir(), '.codex', 'AGENTS.md');
            const chineseRefPattern = /@.*chinese-response\.md/i;
            const chineseSectionPattern = /## 中文回复/;
            const oldCodexRefPattern = /- \*\*中文回复准则\*\*:\s*@.*chinese-response\.md/i;
            let claudeEnabled = false;
            let codexEnabled = false;
            let codexNeedsMigration = false;
            if (existsSync(userClaudePath)) {
                const content = readFileSync(userClaudePath, 'utf8');
                claudeEnabled = chineseRefPattern.test(content);
            }
            if (existsSync(userCodexPath)) {
                const content = readFileSync(userCodexPath, 'utf8');
                codexEnabled = chineseSectionPattern.test(content);
                if (codexEnabled && oldCodexRefPattern.test(content)) {
                    codexNeedsMigration = true;
                }
            }
            const guidelinesPath = join(homedir(), '.maestro', 'workflows', 'chinese-response.md');
            const guidelinesExists = existsSync(guidelinesPath);
            return c.json({ claudeEnabled, codexEnabled, codexNeedsMigration, guidelinesExists });
        }
        catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // POST /api/language/chinese-response — toggle on/off
    // -----------------------------------------------------------------------
    app.post('/api/language/chinese-response', async (c) => {
        try {
            const body = await c.req.json();
            const { enabled, target = 'claude' } = body;
            if (typeof enabled !== 'boolean') {
                return c.json({ error: 'Missing or invalid enabled parameter' }, 400);
            }
            const guidelinesPath = join(homedir(), '.maestro', 'workflows', 'chinese-response.md');
            if (!existsSync(guidelinesPath)) {
                return c.json({ error: 'Chinese response guidelines file not found at ~/.maestro/workflows/chinese-response.md' }, 404);
            }
            const guidelinesRef = '~/.maestro/workflows/chinese-response.md';
            const isCodex = target === 'codex';
            const targetDir = isCodex ? join(homedir(), '.codex') : join(homedir(), '.claude');
            const targetFile = isCodex ? join(targetDir, 'AGENTS.md') : join(targetDir, 'CLAUDE.md');
            if (!existsSync(targetDir)) {
                mkdirSync(targetDir, { recursive: true });
            }
            let content = '';
            if (existsSync(targetFile)) {
                content = readFileSync(targetFile, 'utf8');
            }
            else {
                content = isCodex ? '# Codex Code Guidelines\n\n' : '# Claude Instructions\n\n';
            }
            if (isCodex) {
                const chineseSectionRe = /\n*## 中文回复\n[\s\S]*?(?=\n## |$)/;
                const oldRefRe = /- \*\*中文回复准则\*\*:\s*@.*chinese-response\.md/i;
                if (enabled) {
                    const hasSection = chineseSectionRe.test(content);
                    if (hasSection) {
                        const hasOldRef = oldRefRe.test(content);
                        if (hasOldRef) {
                            content = content.replace(chineseSectionRe, '\n').replace(/\n{3,}/g, '\n\n').trim();
                            if (content)
                                content += '\n';
                            const chineseContent = readFileSync(guidelinesPath, 'utf8');
                            content = content.trimEnd() + '\n\n## 中文回复\n\n' + chineseContent + '\n';
                            writeFileSync(targetFile, content, 'utf8');
                            return c.json({ success: true, enabled, migrated: true });
                        }
                        return c.json({ success: true, message: 'Already enabled' });
                    }
                    const chineseContent = readFileSync(guidelinesPath, 'utf8');
                    content = content.trimEnd() + '\n\n## 中文回复\n\n' + chineseContent + '\n';
                }
                else {
                    content = content.replace(chineseSectionRe, '\n').replace(/\n{3,}/g, '\n\n').trim();
                    if (content)
                        content += '\n';
                }
            }
            else {
                const chineseRefLine = `- **中文回复准则**: @${guidelinesRef}`;
                const chineseRefRe = /^- \*\*中文回复准则\*\*:.*chinese-response\.md.*$/gm;
                const chineseSectionRe = /\n*## 中文回复\n+- \*\*中文回复准则\*\*:.*chinese-response\.md.*\n*/gm;
                if (enabled) {
                    if (chineseRefRe.test(content)) {
                        return c.json({ success: true, message: 'Already enabled' });
                    }
                    content = content.trimEnd() + '\n\n## 中文回复\n\n' + chineseRefLine + '\n';
                }
                else {
                    content = content.replace(chineseSectionRe, '\n').replace(/\n{3,}/g, '\n\n').trim();
                    if (content)
                        content += '\n';
                }
            }
            writeFileSync(targetFile, content, 'utf8');
            return c.json({ success: true, enabled, target });
        }
        catch (error) {
            return c.json({ error: error.message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // GET /api/settings/spec-injection — read spec injection config
    // -----------------------------------------------------------------------
    app.get('/api/settings/spec-injection', async (c) => {
        const p = getPaths();
        // Default agent-type → categories mapping (reference data for UI)
        const agentCategoryMap = {
            'code-developer': ['coding', 'learning', 'ui'],
            'tdd-developer': ['coding', 'test'],
            'workflow-executor': ['coding'],
            'universal-executor': ['coding', 'ui'],
            'test-fix-agent': ['coding', 'test'],
            'cli-lite-planning-agent': ['arch'],
            'action-planning-agent': ['arch'],
            'workflow-planner': ['arch'],
            'workflow-reviewer': ['review'],
            'debug-explore-agent': ['debug'],
            'workflow-debugger': ['debug'],
            'general': ['coding', 'learning'],
        };
        // Default category → filename mapping (reference data for UI)
        const categoryFileMap = {
            coding: 'coding-conventions.md',
            arch: 'architecture-constraints.md',
            debug: 'debug-notes.md',
            test: 'test-conventions.md',
            review: 'review-standards.md',
            learning: 'learnings.md',
            ui: 'ui-conventions.md',
        };
        const validCategories = ['coding', 'arch', 'debug', 'test', 'review', 'learning', 'ui'];
        let config = {};
        try {
            const raw = await readFile(p.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            config = json['specInjection'] ?? {};
        }
        catch {
            // No config yet
        }
        return c.json({
            config,
            defaults: { agentCategoryMap, categoryFileMap, validCategories },
        });
    });
    // -----------------------------------------------------------------------
    // PUT /api/settings/spec-injection — write spec injection config
    // -----------------------------------------------------------------------
    app.put('/api/settings/spec-injection', async (c) => {
        try {
            const p = getPaths();
            const body = await c.req.json();
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            config['specInjection'] = body;
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    // -----------------------------------------------------------------------
    // Workflow config — exclude keys managed by other settings sections
    // -----------------------------------------------------------------------
    /** Keys owned by dashboard settings / commander — never exposed via workflow-config API */
    const DASHBOARD_OWNED_KEYS = new Set(['settings', 'dashboard', 'commander', 'specInjection']);
    function isWorkflowKey(key) {
        return !DASHBOARD_OWNED_KEYS.has(key);
    }
    // -----------------------------------------------------------------------
    // GET /api/workflow-config — read all workflow configuration dynamically
    // -----------------------------------------------------------------------
    app.get('/api/workflow-config', async (c) => {
        const p = getPaths();
        try {
            const raw = await readFile(p.dashboardConfig, 'utf-8');
            const json = JSON.parse(raw);
            const result = {};
            for (const key of Object.keys(json)) {
                if (isWorkflowKey(key))
                    result[key] = json[key];
            }
            return c.json(result);
        }
        catch {
            return c.json({});
        }
    });
    // -----------------------------------------------------------------------
    // PUT /api/workflow-config — write workflow configuration (dynamic keys)
    // -----------------------------------------------------------------------
    app.put('/api/workflow-config', async (c) => {
        try {
            const p = getPaths();
            const body = (await c.req.json());
            let config = {};
            try {
                const raw = await readFile(p.dashboardConfig, 'utf-8');
                config = JSON.parse(raw);
            }
            catch {
                // Start with empty config
            }
            // Merge only workflow keys from body, preserve dashboard-owned keys
            for (const key of Object.keys(body)) {
                if (isWorkflowKey(key)) {
                    config[key] = body[key];
                }
            }
            await writeFile(p.dashboardConfig, JSON.stringify(config, null, 2), 'utf-8');
            return c.json({ ok: true });
        }
        catch (err) {
            const message = err instanceof Error ? err.message : 'Write failed';
            return c.json({ ok: false, error: message }, 500);
        }
    });
    return app;
}
//# sourceMappingURL=settings.js.map