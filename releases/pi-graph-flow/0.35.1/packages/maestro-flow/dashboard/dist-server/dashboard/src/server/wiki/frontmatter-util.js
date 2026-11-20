// Frontmatter parser extracted verbatim from routes/specs.ts so both routes
// share a single source of truth. Matches spec-index-builder.ts behavior.
export function parseFrontmatter(raw) {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith('---')) {
        return { data: {}, content: raw };
    }
    const endIdx = trimmed.indexOf('\n---', 3);
    if (endIdx === -1) {
        return { data: {}, content: raw };
    }
    const yamlBlock = trimmed.substring(3, endIdx).trim();
    const content = trimmed.substring(endIdx + 4);
    const data = {};
    let currentKey = '';
    let arrayItems = null;
    for (const line of yamlBlock.split('\n')) {
        const trimLine = line.trim();
        if (trimLine.startsWith('- ') && arrayItems !== null) {
            arrayItems.push(trimLine.substring(2).trim());
            continue;
        }
        if (arrayItems !== null && currentKey) {
            data[currentKey] = arrayItems;
            arrayItems = null;
        }
        const colonIdx = trimLine.indexOf(':');
        if (colonIdx === -1)
            continue;
        const key = trimLine.substring(0, colonIdx).trim();
        const value = trimLine.substring(colonIdx + 1).trim();
        currentKey = key;
        if (value === '' || value === '[]') {
            arrayItems = [];
        }
        else if (value.startsWith('[') && value.endsWith(']')) {
            data[key] = value
                .slice(1, -1)
                .split(',')
                .map((s) => s.trim().replace(/^["']|["']$/g, ''))
                .filter((s) => s.length > 0);
        }
        else {
            data[key] = value.replace(/^["']|["']$/g, '');
        }
    }
    if (arrayItems !== null && currentKey) {
        data[currentKey] = arrayItems;
    }
    return { data, content };
}
//# sourceMappingURL=frontmatter-util.js.map