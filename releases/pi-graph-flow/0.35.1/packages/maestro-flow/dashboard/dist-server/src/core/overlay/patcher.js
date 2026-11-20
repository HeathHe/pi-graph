// ---------------------------------------------------------------------------
// Patcher — applies overlay patches to command file contents using
// hashed HTML-comment markers for idempotent insertion/removal.
//
// Marker format:
//   <!-- maestro-overlay:<name>#<idx> hash=<shortHash> -->
//   ...injected content...
//   <!-- /maestro-overlay:<name>#<idx> -->
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { parseSections, joinLines, findSection, } from './section-parser.js';
export function shortHash(input) {
    return createHash('sha256').update(input).digest('hex').slice(0, 8);
}
function markerStart(name, idx, hash) {
    return `<!-- maestro-overlay:${name}#${idx} hash=${hash} -->`;
}
function markerEnd(name, idx) {
    return `<!-- /maestro-overlay:${name}#${idx} -->`;
}
function makeMarkerBlock(name, idx, content) {
    const hash = shortHash(content);
    const lines = content.replace(/\r\n/g, '\n').split('\n');
    // Strip trailing empty lines so the block stays compact.
    while (lines.length > 0 && lines[lines.length - 1] === '')
        lines.pop();
    return [markerStart(name, idx, hash), ...lines, markerEnd(name, idx)];
}
/** Escape regex metacharacters. */
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
/**
 * Strip any existing marker block for `(name, idx)` from lines in place.
 * Returns the first line index where the block used to start, or -1.
 */
function stripExistingMarker(lines, name, idx) {
    const startRe = new RegExp(`^<!--\\s*maestro-overlay:${escapeRe(name)}#${idx}\\b.*-->\\s*$`);
    const endRe = new RegExp(`^<!--\\s*/maestro-overlay:${escapeRe(name)}#${idx}\\s*-->\\s*$`);
    let startLine = -1;
    let endLine = -1;
    for (let i = 0; i < lines.length; i++) {
        if (startRe.test(lines[i])) {
            startLine = i;
            for (let j = i + 1; j < lines.length; j++) {
                if (endRe.test(lines[j])) {
                    endLine = j;
                    break;
                }
            }
            break;
        }
    }
    if (startLine === -1)
        return -1;
    if (endLine === -1) {
        throw new Error(`Corrupted overlay marker: start found for ${name}#${idx} but no matching end tag`);
    }
    lines.splice(startLine, endLine - startLine + 1);
    return startLine;
}
/** Strip any marker block for overlay `name`, regardless of patch index. */
function stripAllMarkersForOverlay(lines, name) {
    const startRe = new RegExp(`^<!--\\s*maestro-overlay:${escapeRe(name)}#(\\d+)\\b.*-->\\s*$`);
    const endRe = (idx) => new RegExp(`^<!--\\s*/maestro-overlay:${escapeRe(name)}#${idx}\\s*-->\\s*$`);
    const removedIndices = [];
    let i = 0;
    while (i < lines.length) {
        const m = startRe.exec(lines[i]);
        if (!m) {
            i++;
            continue;
        }
        const idx = m[1];
        const endR = endRe(idx);
        let endLine = -1;
        for (let j = i + 1; j < lines.length; j++) {
            if (endR.test(lines[j])) {
                endLine = j;
                break;
            }
        }
        if (endLine === -1) {
            throw new Error(`Corrupted overlay marker: start found for ${name}#${idx} but no matching end tag`);
        }
        lines.splice(i, endLine - i + 1);
        removedIndices.push(Number(idx));
        // Do not advance i — continue scanning from same position after splice.
    }
    return removedIndices;
}
/**
 * Apply all of an overlay's patches to the target file content.
 *
 * The file is reparsed after each marker edit so subsequent patches see
 * the updated line indices.
 */
export function applyOverlay(text, overlay, commandName, commandPath) {
    const originalText = text;
    let parsed = parseSections(text);
    let lines = parsed.lines.slice();
    const sectionsPatched = [];
    const markerIds = [];
    overlay.meta.patches.forEach((patch, idx) => {
        // Remove any existing block for this (overlay, idx) first — supports
        // re-apply when content has changed.
        stripExistingMarker(lines, overlay.meta.name, idx);
        parsed = parseSections(joinLines(lines, parsed.eol));
        lines = parsed.lines.slice();
        const applied = applyPatch(lines, parsed, overlay.meta.name, idx, patch);
        if (applied) {
            sectionsPatched.push(patch.section);
            markerIds.push(`${overlay.meta.name}#${idx}`);
            parsed = parseSections(joinLines(lines, parsed.eol));
        }
    });
    // Rebuild text preserving original EOL.
    let out = joinLines(lines, parsed.eol);
    // Normalize trailing newline to exactly one.
    out = out.replace(/\r?\n+$/, '') + parsed.eol;
    return {
        text: out,
        unchanged: out === originalText,
        applied: {
            commandName,
            commandPath,
            sectionsPatched,
            markerIds,
        },
    };
}
/**
 * Apply a single patch to lines. Mutates `lines` in place.
 * Returns true if the patch was applied.
 */
function applyPatch(lines, parsed, overlayName, patchIdx, patch) {
    if (patch.mode === 'new-section') {
        return applyNewSection(lines, parsed, overlayName, patchIdx, patch);
    }
    const span = findSection(parsed, patch.section);
    if (!span) {
        // Section not found — skip silently. Validation should catch this upstream.
        return false;
    }
    const block = makeMarkerBlock(overlayName, patchIdx, patch.content);
    if (patch.mode === 'append') {
        // Insert directly before </section>. No padding — round-trip must
        // yield the original bytes, and removeOverlay only strips marker lines.
        lines.splice(span.closeLine, 0, ...block);
        return true;
    }
    if (patch.mode === 'prepend') {
        // Insert directly after <section>. Same reasoning as append.
        lines.splice(span.openLine + 1, 0, ...block);
        return true;
    }
    if (patch.mode === 'replace') {
        // Replace everything strictly between the open/close tags.
        const from = span.openLine + 1;
        const to = span.closeLine; // exclusive
        lines.splice(from, to - from, ...block);
        return true;
    }
    return false;
}
function applyNewSection(lines, parsed, overlayName, patchIdx, patch) {
    // Guard against duplicate section injection.
    if (findSection(parsed, patch.section))
        return false;
    const block = [
        `<${patch.section}>`,
        ...makeMarkerBlock(overlayName, patchIdx, patch.content),
        `</${patch.section}>`,
    ];
    let insertAt;
    if (patch.afterSection) {
        const anchor = findSection(parsed, patch.afterSection);
        if (!anchor)
            return false;
        insertAt = anchor.closeLine + 1;
    }
    else {
        insertAt = lines.length;
    }
    lines.splice(insertAt, 0, '', ...block, '');
    return true;
}
/**
 * Remove every marker block for a given overlay name from the text.
 * Returns the cleaned text and the patch indices that were removed.
 */
export function removeOverlay(text, overlayName) {
    const parsed = parseSections(text);
    const lines = parsed.lines.slice();
    const removed = stripAllMarkersForOverlay(lines, overlayName);
    if (removed.length === 0) {
        return { text, removed };
    }
    // Also drop any now-empty custom sections that were created by new-section
    // patches from this overlay. A custom section is detectable as a <slug>
    // block with no meaningful content remaining. Keep this simple: leave
    // empty sections in place; user can clean up manually if needed.
    let out = joinLines(lines, parsed.eol);
    out = out.replace(/\r?\n+$/, '') + parsed.eol;
    return { text: out, removed };
}
/** Detect whether `text` already contains markers for this overlay name. */
export function hasMarkers(text, overlayName) {
    const re = new RegExp(`<!--\\s*maestro-overlay:${escapeRe(overlayName)}#\\d+\\b`);
    return re.test(text);
}
//# sourceMappingURL=patcher.js.map