import type { Command } from 'commander';
/**
 * Keep the retired command parseable for existing scripts without exposing or
 * starting the dashboard. The legacy options are intentionally accepted as
 * no-ops so upgrades do not turn them into Commander usage errors.
 */
export declare function registerViewCommand(program: Command): void;
//# sourceMappingURL=view.d.ts.map