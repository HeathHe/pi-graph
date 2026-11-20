// ---------------------------------------------------------------------------
// `maestro install fonts` — Nerd Font installation guide (cross-platform)
//
// Detects platform and prints platform-specific install instructions.
// No automatic download/install — keeps install flow safe and lightweight.
//
// Default recommendation: JetBrainsMono Nerd Font (well-tested, full glyph
// coverage, common in editor configs). Other Nerd Fonts work equally well.
// ---------------------------------------------------------------------------
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
// Latest stable Nerd Fonts release (update when a new major lands)
const NERD_FONTS_VERSION = 'v3.4.0';
const DEFAULT_FONT = 'JetBrainsMono';
/** Check whether the named Nerd Font is already installed (Linux/macOS only). */
function detectInstalled(fontName) {
    const os = platform();
    if (os !== 'linux' && os !== 'darwin')
        return null;
    try {
        const out = execSync(`fc-list | grep -i "${fontName} Nerd Font"`, {
            timeout: 3000,
            stdio: ['ignore', 'pipe', 'ignore'],
        }).toString();
        return out.trim().length > 0;
    }
    catch {
        return false;
    }
}
export function getNerdFontGuide(font = DEFAULT_FONT) {
    const os = platform();
    const detected = detectInstalled(font);
    const zipUrl = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}/${font}.zip`;
    const releasesUrl = 'https://github.com/ryanoasis/nerd-fonts/releases/latest';
    const lines = [];
    lines.push(`Recommended: ${font} Nerd Font  (Nerd Fonts ${NERD_FONTS_VERSION})`);
    lines.push(`Direct download: ${zipUrl}`);
    lines.push(`All variants:    ${releasesUrl}`);
    lines.push('');
    if (os === 'darwin') {
        lines.push('macOS — Homebrew (recommended):');
        lines.push(`  brew install --cask font-${font.toLowerCase()}-nerd-font`);
        lines.push('');
        lines.push('macOS — manual:');
        lines.push(`  curl -L -o /tmp/${font}.zip ${zipUrl}`);
        lines.push(`  unzip /tmp/${font}.zip -d ~/Library/Fonts/${font}NerdFont/`);
        return { os: 'darwin', detected, lines };
    }
    if (os === 'linux') {
        lines.push('Linux — manual:');
        lines.push(`  mkdir -p ~/.local/share/fonts/${font}NerdFont`);
        lines.push(`  curl -L -o /tmp/${font}.zip ${zipUrl}`);
        lines.push(`  unzip -o /tmp/${font}.zip -d ~/.local/share/fonts/${font}NerdFont`);
        lines.push('  fc-cache -f');
        lines.push('');
        lines.push('Linux — package manager (varies by distro):');
        lines.push(`  Arch:     pacman -S ttf-${font.toLowerCase()}-nerd  (or via AUR)`);
        lines.push(`  Debian:   apt search fonts-${font.toLowerCase()}     (availability varies)`);
        return { os: 'linux', detected, lines };
    }
    if (os === 'win32') {
        lines.push('Windows — Scoop (recommended):');
        lines.push('  scoop bucket add nerd-fonts');
        lines.push(`  scoop install ${font}-NF`);
        lines.push('');
        lines.push('Windows — Winget:');
        lines.push(`  winget search "${font} Nerd Font"`);
        lines.push('  winget install <package id from search>');
        lines.push('');
        lines.push('Windows — manual:');
        lines.push(`  1. Download:  ${zipUrl}`);
        lines.push('  2. Extract the .zip');
        lines.push('  3. Select all .ttf files → right-click → Install for all users');
        return { os: 'win32', detected, lines };
    }
    lines.push(`Unsupported platform "${os}" — visit ${releasesUrl} for manual install.`);
    return { os: 'unknown', detected, lines };
}
/** Print the font guide to stderr (matches install command output style). */
export function printNerdFontGuide(font = DEFAULT_FONT) {
    const guide = getNerdFontGuide(font);
    console.error('');
    console.error('━━━ Nerd Font Setup ━━━');
    if (guide.detected === true) {
        console.error(`✓ ${font} Nerd Font already installed — no action needed.`);
        console.error('');
        return;
    }
    if (guide.detected === false) {
        console.error(`! ${font} Nerd Font not detected on this system.`);
    }
    else {
        console.error('Statusline uses Nerd Font glyphs. Install one to render icons correctly:');
    }
    console.error('');
    for (const line of guide.lines) {
        console.error(line ? `  ${line}` : '');
    }
    console.error('');
    console.error('After install, configure your terminal to use the new font.');
    console.error('');
}
/** Register `maestro install fonts` standalone subcommand. */
export function registerFontsSubcommand(install) {
    install
        .command('fonts')
        .description('Show Nerd Font installation guide for the current platform')
        .option('--font <name>', `Font family (default: ${DEFAULT_FONT})`, DEFAULT_FONT)
        .action((opts) => {
        printNerdFontGuide(opts.font);
    });
}
//# sourceMappingURL=font-guide.js.map