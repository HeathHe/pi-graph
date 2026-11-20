import type { Command } from 'commander';
interface PlatformGuide {
    os: 'linux' | 'darwin' | 'win32' | 'unknown';
    detected: boolean | null;
    lines: string[];
}
export declare function getNerdFontGuide(font?: string): PlatformGuide;
/** Print the font guide to stderr (matches install command output style). */
export declare function printNerdFontGuide(font?: string): void;
/** Register `maestro install fonts` standalone subcommand. */
export declare function registerFontsSubcommand(install: Command): void;
export {};
//# sourceMappingURL=font-guide.d.ts.map