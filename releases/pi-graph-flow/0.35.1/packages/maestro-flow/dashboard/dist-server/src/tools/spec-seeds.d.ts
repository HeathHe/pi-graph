/**
 * Spec Seeds
 *
 * Single source of truth for spec file templates (frontmatter + body).
 * Used by spec-init (initialize), spec-loader (auto-init on load), and
 * spec-writer (create-on-demand when adding an entry to a missing file).
 *
 * Keeps frontmatter format consistent across all entry points so loaded
 * specs always carry their YAML metadata (title, readMode, priority,
 * category, keywords).
 */
export interface SpecSeedFrontmatter {
    title: string;
    readMode: string;
    priority: string;
    category: string;
    keywords: string[];
}
export interface SpecSeedDoc {
    filename: string;
    frontmatter: SpecSeedFrontmatter;
    body: string;
}
export declare const SPEC_SEED_DOCS: SpecSeedDoc[];
/** Build YAML frontmatter block (without trailing newline) for a seed doc. */
export declare function formatSeedFrontmatter(fm: SpecSeedFrontmatter): string;
/** Return frontmatter + blank line + body — ready to write to disk. */
export declare function renderSeedContent(doc: SpecSeedDoc): string;
/** True when raw content begins with a YAML frontmatter block. */
export declare function hasFrontmatter(raw: string): boolean;
/** Look up a seed by filename (e.g. 'coding-conventions.md'). */
export declare function findSeedByFilename(filename: string): SpecSeedDoc | undefined;
export interface SpecPreset {
    name: string;
    description: string;
    seeds: SpecSeedDoc[];
}
export declare const SPEC_PRESETS: Record<string, SpecPreset>;
export declare function getPresetSeeds(preset: string): SpecSeedDoc[];
export declare function listPresets(): SpecPreset[];
