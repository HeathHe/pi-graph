// ---------------------------------------------------------------------------
// Overlay types — shared shapes for overlay loading, patching, and tracking.
// ---------------------------------------------------------------------------
/** XML-tagged sections recognised in command and skill files. */
export const KNOWN_SECTIONS = [
    'purpose',
    'required_reading',
    'deferred_reading',
    'context',
    'execution',
    'error_codes',
    'success_criteria',
];
/** Reserved target name for overlays that inject into CLAUDE.md via tag-injector. */
export const CLAUDE_MD_TARGET = '_claude-md';
export const OVERLAY_MANIFEST_VERSION = '1.0';
//# sourceMappingURL=types.js.map