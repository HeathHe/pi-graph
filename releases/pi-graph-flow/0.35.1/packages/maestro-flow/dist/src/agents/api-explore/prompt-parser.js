/**
 * Structured prompt format for maestro explore:
 *
 *   FIND: <what to search for — the core query>
 *   SCOPE: <file patterns, directories, or modules>
 *   EXCLUDE: <what to skip — files, patterns, false positives>
 *   ATTENTION: <caveats, edge cases, things to watch for>
 *   EXPECTED: <output format — evidence list, summary, JSON>
 *
 * Also accepts plain text (passed through unchanged).
 * Legacy fields PURPOSE/FOCUS/CONSTRAINTS map to FIND/ATTENTION/EXCLUDE.
 */
const FIELD_MAP = {
    FIND: 'find',
    SCOPE: 'scope',
    EXCLUDE: 'exclude',
    ATTENTION: 'attention',
    EXPECTED: 'expected',
    // Legacy aliases
    PURPOSE: 'find',
    FOCUS: 'attention',
    CONSTRAINTS: 'exclude',
};
const FIELD_PATTERN = new RegExp(`^(${Object.keys(FIELD_MAP).join('|')})\\s*:\\s*(.*)`, 'i');
const ESCAPED_FIELD_BREAK = new RegExp(`(?:\\\\r)?\\\\n(?=(${Object.keys(FIELD_MAP).join('|')})\\s*:)`, 'gi');
function normalizeStructuredFieldBreaks(text) {
    return text.replace(ESCAPED_FIELD_BREAK, '\n');
}
export function isStructuredPrompt(text) {
    return /^(FIND|PURPOSE)\s*:/im.test(text);
}
export function parseStructuredPrompt(text) {
    const normalizedText = normalizeStructuredFieldBreaks(text);
    const fields = {};
    let currentKey = null;
    const lines = [];
    for (const line of normalizedText.split('\n')) {
        const match = line.match(FIELD_PATTERN);
        if (match) {
            if (currentKey && lines.length > 0) {
                fields[currentKey] = lines.join('\n').trim();
                lines.length = 0;
            }
            currentKey = FIELD_MAP[match[1].toUpperCase()] ?? null;
            if (match[2].trim())
                lines.push(match[2].trim());
        }
        else if (currentKey) {
            lines.push(line);
        }
    }
    if (currentKey && lines.length > 0) {
        fields[currentKey] = lines.join('\n').trim();
    }
    return {
        find: fields.find ?? normalizedText.trim(),
        scope: fields.scope,
        exclude: fields.exclude,
        attention: fields.attention,
        expected: fields.expected,
    };
}
export function buildExplorePrompt(input) {
    const parsed = typeof input === 'string'
        ? (isStructuredPrompt(input) ? parseStructuredPrompt(input) : { find: input })
        : input;
    const parts = [`**Query**: ${parsed.find}`];
    if (parsed.scope)
        parts.push(`**path**: ${parsed.scope}`);
    if (parsed.exclude)
        parts.push(`**exclude**: ${parsed.exclude}`);
    if (parsed.attention)
        parts.push(`**Note**: ${parsed.attention}`);
    if (parsed.expected)
        parts.push(`**Output format**: ${parsed.expected}`);
    return parts.join('\n');
}
//# sourceMappingURL=prompt-parser.js.map