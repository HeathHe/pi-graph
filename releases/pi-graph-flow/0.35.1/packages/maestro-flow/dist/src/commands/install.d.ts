import type { Command } from 'commander';
import type { InstallProfile } from '../core/install-profile.js';
export declare function registerInstallCommand(program: Command): void;
type ProfileHookSelection = InstallProfile['claude']['hooks'];
export declare function enabledCustomHookSelection(selection: ProfileHookSelection): ProfileHookSelection | undefined;
export declare function profilePluginPlatformState(plugin: InstallProfile['plugin'], platform: 'claude' | 'codex'): boolean | undefined;
export {};
//# sourceMappingURL=install.d.ts.map