import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import ignore from 'ignore';
export const MAESTRO_IGNORE_FILE = '.maestroignore';
const DEFAULT_IGNORE_PATTERNS = [
    'node_modules/',
    '.git/',
    'dist/',
    'build/',
    'out/',
    '.next/',
    '.nuxt/',
    '.svelte-kit/',
    '.turbo/',
    '.vite/',
    '__pycache__/',
    '.venv/',
    'venv/',
    '.pytest_cache/',
    '.ruff_cache/',
    'target/',
    '.gradle/',
    'vendor/',
    'coverage/',
    '.cache/',
    '.workflow/',
    '.codegraph/',
];
const DEFAULT_MAESTROIGNORE = `# MaestroGraph code index ignore rules.
# Uses gitignore syntax and is merged after .gitignore.

.workflow/
.codegraph/
node_modules/
dist/
build/
coverage/
.cache/
`;
function readIgnoreFile(path) {
    if (!existsSync(path))
        return '';
    try {
        return readFileSync(path, 'utf-8');
    }
    catch {
        return '';
    }
}
function ensureMaestroIgnore(projectRoot) {
    const path = join(projectRoot, MAESTRO_IGNORE_FILE);
    if (existsSync(path))
        return;
    writeFileSync(path, DEFAULT_MAESTROIGNORE, 'utf-8');
}
function normalizePattern(pattern, dirOnly = false) {
    const trimmed = pattern.trim();
    if (!trimmed)
        return trimmed;
    const normalized = trimmed.replace(/\\/g, '/');
    if (!dirOnly)
        return normalized;
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
}
export function buildScanScope(options) {
    const projectRoot = resolve(options.projectRoot);
    const srcDir = resolve(options.srcDir);
    if (options.createMaestroIgnore !== false) {
        ensureMaestroIgnore(projectRoot);
    }
    const matcher = ignore()
        .add(DEFAULT_IGNORE_PATTERNS)
        .add(readIgnoreFile(join(projectRoot, '.gitignore')))
        .add(readIgnoreFile(join(projectRoot, MAESTRO_IGNORE_FILE)));
    if (options.excludeDirs) {
        matcher.add(options.excludeDirs.map(pattern => normalizePattern(pattern, true)).filter(Boolean));
    }
    if (options.excludeFiles) {
        matcher.add(options.excludeFiles.map(pattern => normalizePattern(pattern)).filter(Boolean));
    }
    return {
        projectRoot,
        srcDir,
        ignores(absPath, isDirectory = false) {
            const rel = relative(projectRoot, absPath).replace(/\\/g, '/');
            if (!rel || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel))
                return false;
            const candidate = isDirectory && !rel.endsWith('/') ? `${rel}/` : rel;
            return matcher.ignores(candidate);
        },
    };
}
//# sourceMappingURL=scan-scope.js.map