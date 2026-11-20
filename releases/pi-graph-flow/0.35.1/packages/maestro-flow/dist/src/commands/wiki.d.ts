/**
 * Wiki Command — CLI for querying and mutating the wiki.
 *
 * Subcommands: list, get, search, health, graph, orphans, hubs,
 * backlinks, forward, create, update, delete
 *
 * By default operates offline by directly reading `.workflow/` files.
 * Use `--live` to route through the dashboard HTTP API instead.
 * Base URL defaults to http://127.0.0.1:3001 and can be overridden with
 * `--base <url>` or `MAESTRO_DASHBOARD_URL`.
 */
import type { Command } from 'commander';
export declare function registerWikiCommand(program: Command): void;
//# sourceMappingURL=wiki.d.ts.map