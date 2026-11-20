// ---------------------------------------------------------------------------
// `maestro plugin` — register maestro as a native Claude Code / Codex plugin
//
// Subcommands:
//   maestro plugin install   — build staging + register as plugin
//   maestro plugin uninstall — remove plugin registration + cleanup
//   maestro plugin status    — show registration state on both platforms
// ---------------------------------------------------------------------------
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { getPackageRoot } from './install-backend.js';
import { findManifest } from '../core/manifest.js';
import { paths } from '../config/paths.js';
function getVersion(pkgRoot) {
    const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf-8'));
    return pkg.version ?? '0.1.0';
}
// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------
function registerInstallSubcommand(plugin) {
    plugin
        .command('install')
        .description('Register maestro as a native plugin on Claude Code and Codex')
        .option('--claude-only', 'Only register on Claude Code')
        .option('--codex-only', 'Only register on Codex')
        .action(async (opts) => {
        const { installPlugin, loadState, } = await import('../core/plugin-bridge.js');
        const pkgRoot = getPackageRoot();
        const version = getVersion(pkgRoot);
        // Check for existing global install
        const globalManifest = findManifest('global', paths.home);
        if (globalManifest) {
            console.error('  ⚠ Detected existing global install (maestro install --global).');
            console.error('    Plugin mode and global mode are independent — both can coexist,');
            console.error('    but you may see duplicate skills. Consider running:');
            console.error('    maestro uninstall --all -y');
            console.error('');
        }
        const doClaude = !opts.codexOnly;
        const doCodex = !opts.claudeOnly;
        console.error(`  Installing Maestro Flow v${version} as native plugin...`);
        console.error('');
        const result = installPlugin(pkgRoot, version, {
            claude: doClaude,
            codex: doCodex,
        });
        if (doClaude) {
            const sym = result.claude.success ? '✓' : '✗';
            console.error(`  ${sym} Claude Code: ${result.claude.detail}`);
        }
        if (doCodex) {
            const sym = result.codex.success ? '✓' : '✗';
            console.error(`  ${sym} Codex: ${result.codex.detail}`);
        }
        const anySuccess = (doClaude && result.claude.success) || (doCodex && result.codex.success);
        if (anySuccess) {
            console.error('');
            console.error('  Restart Claude Code / Codex to load the plugin.');
            console.error('  Staging directory: ~/.maestro/plugin-bridge/ (do not delete)');
        }
        console.error('');
    });
}
function registerUninstallSubcommand(plugin) {
    plugin
        .command('uninstall')
        .description('Remove maestro plugin registration from Claude Code and Codex')
        .option('--claude-only', 'Only remove from Claude Code')
        .option('--codex-only', 'Only remove from Codex')
        .option('--keep-staging', 'Keep staging directory (do not delete copied files)')
        .action(async (opts) => {
        const { uninstallPlugin } = await import('../core/plugin-bridge.js');
        console.error('  Removing Maestro Flow plugin...');
        console.error('');
        const result = uninstallPlugin({
            claude: !opts.codexOnly,
            codex: !opts.claudeOnly,
            cleanStaging: !opts.keepStaging,
        });
        if (!opts.codexOnly) {
            console.error(`  Claude Code: ${result.claude}`);
        }
        if (!opts.claudeOnly) {
            console.error(`  Codex: ${result.codex}`);
        }
        console.error('');
    });
}
function registerStatusSubcommand(plugin) {
    plugin
        .command('status')
        .description('Show maestro plugin registration status')
        .action(async () => {
        const { getClaudeStatus, getCodexStatus, loadState, } = await import('../core/plugin-bridge.js');
        const state = loadState();
        console.error('  Maestro Flow Plugin Status');
        console.error('  ─────────────────────────');
        // Claude
        const claude = getClaudeStatus();
        const claudeState = state.claude;
        console.error('');
        console.error(`  Claude Code:`);
        console.error(`    CLI:         ${claude.cliAvailable ? '✓ available' : '✗ not found'}`);
        console.error(`    Marketplace: ${claude.marketplaceRegistered ? '✓ registered' : '· not registered'}`);
        console.error(`    Plugin:      ${claude.pluginInstalled ? '✓ installed' : '· not installed'}`);
        if (claudeState) {
            console.error(`    Version:     ${claudeState.version}`);
            console.error(`    Installed:   ${claudeState.installedAt.split('T')[0]}`);
        }
        // Codex
        const codex = getCodexStatus();
        const codexState = state.codex;
        console.error('');
        console.error(`  Codex:`);
        console.error(`    CLI:         ${codex.cliAvailable ? '✓ available' : '✗ not found'}`);
        console.error(`    Marketplace: ${codex.marketplaceRegistered ? '✓ registered' : '· not registered'}`);
        console.error(`    Plugin:      ${codex.pluginInstalled ? '✓ installed' : '· not installed'}`);
        if (codexState) {
            console.error(`    Version:     ${codexState.version}`);
            console.error(`    Installed:   ${codexState.installedAt.split('T')[0]}`);
        }
        console.error('');
    });
}
// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------
export function registerPluginCommand(program) {
    const plugin = program
        .command('plugin')
        .description('Register maestro as a native Claude Code / Codex plugin');
    registerInstallSubcommand(plugin);
    registerUninstallSubcommand(plugin);
    registerStatusSubcommand(plugin);
}
//# sourceMappingURL=plugin.js.map