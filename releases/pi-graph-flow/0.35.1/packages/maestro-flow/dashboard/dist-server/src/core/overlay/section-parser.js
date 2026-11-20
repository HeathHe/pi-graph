// ---------------------------------------------------------------------------
// Section parser for `.claude/commands/*.md` files.
//
// Parses YAML frontmatter boundary and XML-style section tags
// (<purpose>, <execution>, ...) into line-indexed spans. Pure — no filesystem.
//
// Fenced code blocks (``` and ~~~) are tracked so tag-like lines inside
// fences are ignored.
// ---------------------------------------------------------------------------
const OPEN_TAG = /^<([a-zA-Z][a-zA-Z0-9_]*)>\s*$/;
const CLOSE_TAG = /^<\/([a-zA-Z][a-zA-Z0-9_]*)>\s*$/;
const FENCE = /^(```+|~~~+)/;
export function detectEol(text) {
    const firstLf = text.indexOf('\n');
    if (firstLf === -1)
        return '\n';
    return text[firstLf - 1] === '\r' ? '\r\n' : '\n';
}
export function splitLines(text) {
    // Strip trailing newline(s) so `lines.join(eol)` round-trips cleanly.
    return text.replace(/\r\n/g, '\n').split('\n');
}
export function joinLines(lines, eol) {
    return lines.join(eol);
}
export function parseSections(text) {
    const eol = detectEol(text);
    const lines = splitLines(text);
    const sections = [];
    const openStack = [];
    let frontmatterStart = -1;
    let frontmatterEnd = -1;
    let fenceOpen = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Fenced code block tracking — fences must start at column 0.
        const fenceMatch = FENCE.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1][0]; // '`' or '~'
            if (!fenceOpen) {
                fenceOpen = marker;
            }
            else if (fenceOpen === marker) {
                fenceOpen = null;
            }
            continue;
        }
        if (fenceOpen)
            continue;
        // Frontmatter: first `---` at line 0, matching close later.
        if (line === '---') {
            if (frontmatterStart === -1 && i === 0) {
                frontmatterStart = 0;
                continue;
            }
            if (frontmatterStart === 0 && frontmatterEnd === -1) {
                frontmatterEnd = i;
                continue;
            }
        }
        // Skip anything inside frontmatter.
        if (frontmatterStart === 0 && frontmatterEnd === -1)
            continue;
        const open = OPEN_TAG.exec(line);
        if (open) {
            openStack.push({ name: open[1], line: i });
            continue;
        }
        const close = CLOSE_TAG.exec(line);
        if (close) {
            // Close the nearest matching open on the stack.
            for (let s = openStack.length - 1; s >= 0; s--) {
                if (openStack[s].name === close[1]) {
                    sections.push({
                        name: close[1],
                        openLine: openStack[s].line,
                        closeLine: i,
                    });
                    openStack.splice(s, 1);
                    break;
                }
            }
        }
    }
    // Sort sections by open line for deterministic iteration.
    sections.sort((a, b) => a.openLine - b.openLine);
    return {
        lines,
        eol,
        frontmatterStart,
        frontmatterEnd,
        sections,
    };
}
/** Find a section by name. Returns the first occurrence or undefined. */
export function findSection(parsed, name) {
    return parsed.sections.find((s) => s.name === name);
}
//# sourceMappingURL=section-parser.js.map