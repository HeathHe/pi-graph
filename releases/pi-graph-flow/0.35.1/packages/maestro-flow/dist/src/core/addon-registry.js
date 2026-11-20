// ---------------------------------------------------------------------------
// Addon Registry — external skills installable via maestro install wizard.
//
// Each addon supports multiple harness targets (Claude Code, Codex, etc.).
// The install route copies from repo source paths to target harness dirs.
// ---------------------------------------------------------------------------
/** Harness dir mapping: harness → dotdir */
export const HARNESS_DIRS = {
    claude: '.claude',
    codex: '.codex',
};
export const ADDON_REGISTRY = [
    {
        id: 'ui-ux-pro-max',
        name: 'UI/UX Pro Max',
        description: 'Design intelligence — 50+ styles, 97 palettes, 57 font pairings, 99 UX guidelines across 9 stacks',
        repo: 'nextlevelbuilder/ui-ux-pro-max-skill',
        branch: 'main',
        targets: [
            { harness: 'claude', srcPath: '.claude/skills/ui-ux-pro-max', destPath: '.claude/skills/ui-ux-pro-max' },
            // Codex: reuse claude skill — same SKILL.md works in .codex/skills/
            { harness: 'codex', srcPath: '.claude/skills/ui-ux-pro-max', destPath: '.codex/skills/ui-ux-pro-max' },
        ],
        homepage: 'https://github.com/nextlevelbuilder/ui-ux-pro-max-skill',
        tags: ['design', 'ui', 'ux', 'tokens', 'typography'],
    },
];
//# sourceMappingURL=addon-registry.js.map