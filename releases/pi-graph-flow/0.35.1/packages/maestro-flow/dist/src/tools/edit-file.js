/**
 * Edit File Tool - AI-focused file editing
 * Two complementary modes:
 * - update: Content-driven text replacement (AI primary use)
 * - line: Position-driven line operations (precise control)
 *
 * Features:
 * - dryRun mode for previewing changes
 * - Git-style diff output
 * - Multi-edit support in update mode
 * - Auto line-ending adaptation (CRLF/LF)
 */
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { validatePath } from '../utils/path-validator.js';
// Define Zod schemas for validation
const EditItemSchema = z.object({
    oldText: z.string(),
    newText: z.string(),
});
// Base schema with common parameters
const BaseParamsSchema = z.object({
    path: z.string().min(1, 'Path is required'),
    dryRun: z.boolean().default(false),
});
// Update mode schema (validation done in handler to avoid ZodEffects incompatibility)
const UpdateModeSchema = BaseParamsSchema.extend({
    mode: z.literal('update').default('update'),
    oldText: z.string().optional(),
    newText: z.string().optional(),
    edits: z.array(EditItemSchema).optional(),
    replaceAll: z.boolean().default(false),
});
// Line mode schema (validation done in handler)
const LineModeSchema = BaseParamsSchema.extend({
    mode: z.literal('line'),
    operation: z.enum(['insert_before', 'insert_after', 'replace', 'delete']),
    line: z.number().int().positive('Line must be a positive integer'),
    end_line: z.number().int().positive().optional(),
    text: z.string().optional(),
});
// Discriminated union schema
const ParamsSchema = z.discriminatedUnion('mode', [
    UpdateModeSchema,
    LineModeSchema,
]);
const MAX_DIFF_LINES = 15;
async function readFile(filePath) {
    const resolvedPath = await validatePath(filePath, { mustExist: true });
    if (!existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
    }
    try {
        const content = readFileSync(resolvedPath, 'utf8');
        return { resolvedPath, content };
    }
    catch (error) {
        throw new Error(`Failed to read file: ${error.message}`);
    }
}
function writeFile(filePath, content, createDirs = false) {
    try {
        if (createDirs) {
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }
        }
        writeFileSync(filePath, content, 'utf8');
    }
    catch (error) {
        throw new Error(`Failed to write file: ${error.message}`);
    }
}
function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, '\n');
}
function createUnifiedDiff(original, modified, filePath) {
    const origLines = normalizeLineEndings(original).split('\n');
    const modLines = normalizeLineEndings(modified).split('\n');
    const diffLines = [`--- a/${filePath}`, `+++ b/${filePath}`];
    let i = 0, j = 0;
    let hunk = [];
    let origStart = 0;
    let modStart = 0;
    while (i < origLines.length || j < modLines.length) {
        if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
            if (hunk.length > 0) {
                hunk.push(` ${origLines[i]}`);
            }
            i++;
            j++;
        }
        else {
            if (hunk.length === 0) {
                origStart = i + 1;
                modStart = j + 1;
                const contextStart = Math.max(0, i - 3);
                for (let c = contextStart; c < i; c++) {
                    hunk.push(` ${origLines[c]}`);
                }
                origStart = contextStart + 1;
                modStart = contextStart + 1;
            }
            let foundMatch = false;
            for (let lookAhead = 1; lookAhead <= 10; lookAhead++) {
                if (i + lookAhead < origLines.length &&
                    j < modLines.length &&
                    origLines[i + lookAhead] === modLines[j]) {
                    for (let r = 0; r < lookAhead; r++) {
                        hunk.push(`-${origLines[i + r]}`);
                    }
                    i += lookAhead;
                    foundMatch = true;
                    break;
                }
                if (j + lookAhead < modLines.length &&
                    i < origLines.length &&
                    modLines[j + lookAhead] === origLines[i]) {
                    for (let a = 0; a < lookAhead; a++) {
                        hunk.push(`+${modLines[j + a]}`);
                    }
                    j += lookAhead;
                    foundMatch = true;
                    break;
                }
            }
            if (!foundMatch) {
                if (i < origLines.length) {
                    hunk.push(`-${origLines[i]}`);
                    i++;
                }
                if (j < modLines.length) {
                    hunk.push(`+${modLines[j]}`);
                    j++;
                }
            }
        }
        const lastChangeIdx = hunk.findLastIndex((l) => l.startsWith('+') || l.startsWith('-'));
        if (lastChangeIdx >= 0 && hunk.length - lastChangeIdx > 3) {
            const origCount = hunk.filter((l) => !l.startsWith('+')).length;
            const modCount = hunk.filter((l) => !l.startsWith('-')).length;
            diffLines.push(`@@ -${origStart},${origCount} +${modStart},${modCount} @@`);
            diffLines.push(...hunk);
            hunk = [];
        }
    }
    if (hunk.length > 0) {
        const origCount = hunk.filter((l) => !l.startsWith('+')).length;
        const modCount = hunk.filter((l) => !l.startsWith('-')).length;
        diffLines.push(`@@ -${origStart},${origCount} +${modStart},${modCount} @@`);
        diffLines.push(...hunk);
    }
    return diffLines.length > 2 ? diffLines.join('\n') : '';
}
function executeUpdateMode(content, params, filePath) {
    const { oldText, newText, replaceAll, edits, dryRun = false } = params;
    const hasCRLF = content.includes('\r\n');
    const normalizedContent = normalizeLineEndings(content);
    const originalContent = normalizedContent;
    let newContent = normalizedContent;
    let replacements = 0;
    const editResults = [];
    const editOperations = edits || (oldText !== undefined ? [{ oldText, newText: newText || '' }] : []);
    if (editOperations.length === 0) {
        throw new Error('Either "oldText/newText" or "edits" array is required for update mode');
    }
    for (const edit of editOperations) {
        const normalizedOld = normalizeLineEndings(edit.oldText || '');
        const normalizedNew = normalizeLineEndings(edit.newText || '');
        if (!normalizedOld) {
            editResults.push({ status: 'error', message: 'Empty oldText' });
            continue;
        }
        if (newContent.includes(normalizedOld)) {
            if (replaceAll) {
                const parts = newContent.split(normalizedOld);
                const count = parts.length - 1;
                newContent = parts.join(normalizedNew);
                replacements += count;
                editResults.push({ status: 'replaced_all', count });
            }
            else {
                newContent = newContent.replace(normalizedOld, normalizedNew);
                replacements += 1;
                editResults.push({ status: 'replaced', count: 1 });
            }
        }
        else {
            // Try fuzzy match (trimmed whitespace)
            const lines = newContent.split('\n');
            const oldLines = normalizedOld.split('\n');
            let matchFound = false;
            for (let i = 0; i <= lines.length - oldLines.length; i++) {
                const potentialMatch = lines.slice(i, i + oldLines.length);
                const isMatch = oldLines.every((oldLine, j) => oldLine.trim() === potentialMatch[j].trim());
                if (isMatch) {
                    const indent = lines[i].match(/^\s*/)?.[0] || '';
                    const newLines = normalizedNew.split('\n').map((line, j) => {
                        if (j === 0)
                            return indent + line.trimStart();
                        return line;
                    });
                    lines.splice(i, oldLines.length, ...newLines);
                    newContent = lines.join('\n');
                    replacements += 1;
                    editResults.push({ status: 'replaced_fuzzy', count: 1 });
                    matchFound = true;
                    break;
                }
            }
            if (!matchFound) {
                editResults.push({ status: 'not_found', oldText: normalizedOld.substring(0, 50) });
            }
        }
    }
    if (hasCRLF) {
        newContent = newContent.replace(/\n/g, '\r\n');
    }
    let diff = '';
    if (originalContent !== normalizeLineEndings(newContent)) {
        diff = createUnifiedDiff(originalContent, normalizeLineEndings(newContent), filePath);
    }
    return {
        content: newContent,
        modified: content !== newContent,
        status: replacements > 0 ? 'replaced' : 'not found',
        replacements,
        editResults,
        diff,
        dryRun,
        message: replacements > 0
            ? `${replacements} replacement(s) made${dryRun ? ' (dry run)' : ''}`
            : 'No matches found',
    };
}
function executeLineMode(content, params) {
    const { operation, line, text, end_line } = params;
    const hasCRLF = content.includes('\r\n');
    const normalizedContent = hasCRLF ? content.replace(/\r\n/g, '\n') : content;
    const lines = normalizedContent.split('\n');
    const lineIndex = line - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
        throw new Error(`Line ${line} out of range (1-${lines.length})`);
    }
    const newLines = [...lines];
    let message = '';
    switch (operation) {
        case 'insert_before':
            if (text === undefined)
                throw new Error('Parameter "text" is required for insert_before');
            newLines.splice(lineIndex, 0, text);
            message = `Inserted before line ${line}`;
            break;
        case 'insert_after':
            if (text === undefined)
                throw new Error('Parameter "text" is required for insert_after');
            newLines.splice(lineIndex + 1, 0, text);
            message = `Inserted after line ${line}`;
            break;
        case 'replace': {
            if (text === undefined)
                throw new Error('Parameter "text" is required for replace');
            const endIdx = end_line ? end_line - 1 : lineIndex;
            if (endIdx < lineIndex || endIdx >= lines.length) {
                throw new Error(`end_line ${end_line} is invalid`);
            }
            const deleteCount = endIdx - lineIndex + 1;
            newLines.splice(lineIndex, deleteCount, text);
            message = end_line ? `Replaced lines ${line}-${end_line}` : `Replaced line ${line}`;
            break;
        }
        case 'delete': {
            const endDelete = end_line ? end_line - 1 : lineIndex;
            if (endDelete < lineIndex || endDelete >= lines.length) {
                throw new Error(`end_line ${end_line} is invalid`);
            }
            const count = endDelete - lineIndex + 1;
            newLines.splice(lineIndex, count);
            message = end_line ? `Deleted lines ${line}-${end_line}` : `Deleted line ${line}`;
            break;
        }
        default:
            throw new Error(`Unknown operation: ${operation}. Valid: insert_before, insert_after, replace, delete`);
    }
    let newContent = newLines.join('\n');
    if (hasCRLF) {
        newContent = newContent.replace(/\n/g, '\r\n');
    }
    return {
        content: newContent,
        modified: content !== newContent,
        operation,
        line,
        end_line,
        message,
    };
}
// Tool schema for MCP
export const schema = {
    name: 'edit_file',
    description: `Edit file using ONE of two modes. Provide parameters for only ONE mode - mixing modes causes validation error.

**Mode 1: update** (default) - Text replacement
  **path** (string, **REQUIRED**): File path to edit.
  **oldText** (string, **REQUIRED** if not using edits): Text to find and replace.
  **newText** (string, **REQUIRED** if using oldText): Replacement text.
  * OR use **edits** (array) for multiple replacements: [{oldText:"a", newText:"b"}, ...]
  *replaceAll* (boolean): Replace all occurrences (default: false).
  *dryRun* (boolean): Preview diff without modifying (default: false).

  Example:
    edit_file(path="file.ts", oldText="old", newText="new")
    edit_file(path="file.ts", edits=[{oldText:"a", newText:"b"}])
    edit_file(path="file.ts", oldText="x", newText="y", replaceAll=true)

**Mode 2: line** - Line-based operations
  **path** (string, **REQUIRED**): File path to edit.
  **operation** (string, **REQUIRED**): "insert_before" | "insert_after" | "replace" | "delete".
  **line** (number, **REQUIRED**): 1-based line number.
  *text* (string): Content for insert/replace operations.
  *end_line* (number): End line for range operations (replace/delete).
  *dryRun* (boolean): Preview diff without modifying (default: false).

  Example:
    edit_file(path="file.ts", mode="line", operation="insert_after", line=10, text="new line")
    edit_file(path="file.ts", mode="line", operation="delete", line=5, end_line=8)`,
    inputSchema: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: 'Path to the file to modify',
            },
            mode: {
                type: 'string',
                enum: ['update', 'line'],
                description: 'Edit mode (default: update)',
                default: 'update',
            },
            dryRun: {
                type: 'boolean',
                description: 'Preview changes using git-style diff without modifying file (default: false)',
                default: false,
            },
            oldText: {
                type: 'string',
                description: '[update mode] Text to find and replace',
            },
            newText: {
                type: 'string',
                description: '[update mode] Replacement text',
            },
            edits: {
                type: 'array',
                description: '[update mode] Array of {oldText, newText} for multiple replacements',
                items: {
                    type: 'object',
                    properties: {
                        oldText: { type: 'string', description: 'Text to search for' },
                        newText: { type: 'string', description: 'Text to replace with' },
                    },
                    required: ['oldText', 'newText'],
                },
            },
            replaceAll: {
                type: 'boolean',
                description: '[update mode] Replace all occurrences (default: false)',
            },
            operation: {
                type: 'string',
                enum: ['insert_before', 'insert_after', 'replace', 'delete'],
                description: '[line mode] Line operation type',
            },
            line: {
                type: 'number',
                description: '[line mode] Line number (1-based)',
            },
            end_line: {
                type: 'number',
                description: '[line mode] End line for range operations',
            },
            text: {
                type: 'string',
                description: '[line mode] Text for insert/replace operations',
            },
        },
        required: ['path'],
    },
};
function truncateDiff(diff, maxLines) {
    if (!diff)
        return '';
    const lines = diff.split('\n');
    if (lines.length <= maxLines)
        return diff;
    return lines.slice(0, maxLines).join('\n') + `\n... (+${lines.length - maxLines} more lines)`;
}
function detectModeMismatch(params) {
    const hasLineParams = ['operation', 'line', 'end_line'].some(p => params[p] !== undefined);
    const hasUpdateParams = ['oldText', 'newText', 'edits', 'replaceAll'].some(p => params[p] !== undefined);
    const currentMode = params.mode;
    if (hasLineParams && currentMode !== 'line') {
        if (currentMode === 'update' || currentMode === undefined) {
            const modeHint = currentMode === undefined ? '(default)' : '';
            return `Parameter mismatch: detected line-mode parameters (operation/line/end_line) ` +
                `but mode="${currentMode || 'update'}"${modeHint}. ` +
                `Add \`mode: "line"\` to use operation/line parameters, ` +
                `or use oldText/newText/edits for update mode.`;
        }
    }
    if (hasUpdateParams && currentMode === 'line') {
        return `Parameter mismatch: detected update-mode parameters (oldText/newText/edits/replaceAll) ` +
            `but mode="line". ` +
            `Remove \`mode: "line"\` or use operation/line parameters instead.`;
    }
    return null;
}
// Handler function
export async function handler(params) {
    const mismatchError = detectModeMismatch(params);
    if (mismatchError) {
        return { success: false, error: mismatchError };
    }
    const normalizedParams = params.mode === undefined ? { ...params, mode: 'update' } : params;
    const parsed = ParamsSchema.safeParse(normalizedParams);
    if (!parsed.success) {
        return { success: false, error: `Invalid params: ${parsed.error.message}` };
    }
    const { path: filePath, mode, dryRun } = parsed.data;
    try {
        const { resolvedPath, content } = await readFile(filePath);
        let result;
        if (mode === 'line') {
            result = executeLineMode(content, parsed.data);
        }
        else {
            result = executeUpdateMode(content, parsed.data, filePath);
        }
        if (result.modified && !dryRun) {
            writeFile(resolvedPath, result.content);
        }
        const compactResult = {
            path: resolvedPath,
            modified: result.modified,
            message: result.message,
        };
        if ('replacements' in result) {
            compactResult.replacements = result.replacements;
            compactResult.dryRun = result.dryRun;
            if (result.diff) {
                compactResult.diff = truncateDiff(result.diff, MAX_DIFF_LINES);
            }
        }
        return { success: true, result: compactResult };
    }
    catch (error) {
        return { success: false, error: error.message };
    }
}
//# sourceMappingURL=edit-file.js.map