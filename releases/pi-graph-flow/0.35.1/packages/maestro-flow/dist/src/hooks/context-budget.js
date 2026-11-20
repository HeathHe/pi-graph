/**
 * Context Budget Manager
 *
 * Determines how much spec content to inject based on remaining context %.
 * Reads bridge metrics written by the statusline hook.
 *
 * Budget tiers:
 *   > 50% remaining  → full    (inject all specs)
 *   35–50%           → reduced (markdown-aware truncation)
 *   25–35%           → minimal (headings only + learnings)
 *   < 25%            → skip    (context is critical)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BRIDGE_PREFIX, STALE_SECONDS } from './constants.js';
// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
const FULL_THRESHOLD = 50;
const REDUCED_THRESHOLD = 35;
const MINIMAL_THRESHOLD = 25;
/** Default max chars for reduced-tier truncation */
const DEFAULT_MAX_CHARS = 4096;
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Decide how much spec content to inject given current context budget.
 * If no bridge metrics are available, defaults to 'full' (be generous).
 */
export function evaluateContextBudget(specContent, sessionId) {
    if (!specContent)
        return { action: 'skip', reason: 'no content' };
    const remaining = readRemainingPct(sessionId);
    // No metrics → assume plenty of context
    if (remaining === null) {
        return { action: 'full', content: specContent };
    }
    if (remaining > FULL_THRESHOLD) {
        return { action: 'full', content: specContent };
    }
    if (remaining > REDUCED_THRESHOLD) {
        return {
            action: 'reduced',
            content: truncateMarkdown(specContent, DEFAULT_MAX_CHARS),
            reason: `Context at ${100 - remaining}% used — specs truncated`,
        };
    }
    if (remaining > MINIMAL_THRESHOLD) {
        return {
            action: 'minimal',
            content: extractHeadingsOnly(specContent),
            reason: `Context at ${100 - remaining}% used — headings only`,
        };
    }
    return {
        action: 'skip',
        reason: `Context at ${100 - remaining}% used — spec injection skipped`,
    };
}
// ---------------------------------------------------------------------------
// Bridge reader
// ---------------------------------------------------------------------------
function readRemainingPct(sessionId) {
    if (!sessionId)
        return null;
    const metricsPath = join(tmpdir(), `${BRIDGE_PREFIX}${sessionId}.json`);
    if (!existsSync(metricsPath))
        return null;
    try {
        const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
        const now = Math.floor(Date.now() / 1000);
        if (metrics.timestamp && (now - metrics.timestamp) > STALE_SECONDS)
            return null;
        return metrics.remaining_percentage;
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// Markdown truncation (reduced tier)
// ---------------------------------------------------------------------------
/**
 * Markdown-aware truncation: preserve headings + first paragraph per section.
 * Inserts "[... N lines omitted]" for collapsed sections.
 */
export function truncateMarkdown(content, maxChars) {
    if (content.length <= maxChars)
        return content;
    const lines = content.split('\n');
    const result = [];
    let currentLen = 0;
    let inFirstParagraph = false;
    let skippedLines = 0;
    for (const line of lines) {
        const isHeading = /^#{1,6}\s/.test(line);
        const isSeparator = /^---\s*$/.test(line);
        const isEmpty = line.trim() === '';
        if (isHeading || isSeparator) {
            // Flush skipped count
            if (skippedLines > 0) {
                result.push(`[... ${skippedLines} lines omitted]`);
                skippedLines = 0;
            }
            result.push(line);
            currentLen += line.length + 1;
            inFirstParagraph = true;
            continue;
        }
        if (inFirstParagraph && !isEmpty) {
            result.push(line);
            currentLen += line.length + 1;
            if (currentLen > maxChars)
                break;
            continue;
        }
        if (isEmpty && inFirstParagraph) {
            inFirstParagraph = false;
            result.push('');
            continue;
        }
        // Beyond first paragraph — skip
        skippedLines++;
    }
    if (skippedLines > 0) {
        result.push(`[... ${skippedLines} lines omitted]`);
    }
    return result.join('\n');
}
// ---------------------------------------------------------------------------
// Headings-only extraction (minimal tier)
// ---------------------------------------------------------------------------
function extractHeadingsOnly(content) {
    const lines = content.split('\n');
    const headings = lines.filter(l => /^#{1,6}\s/.test(l));
    if (headings.length === 0)
        return '[Specs available but omitted — context is low]';
    return '# Project Specs (headings only — context limited)\n\n' + headings.join('\n');
}
//# sourceMappingURL=context-budget.js.map