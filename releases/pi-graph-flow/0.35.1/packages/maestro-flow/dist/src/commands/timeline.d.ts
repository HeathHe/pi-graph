/**
 * Timeline Command — Unified project activity timeline (git + sessions).
 *
 *   maestro timeline                          — last 30 days, all sources
 *   maestro timeline --since 7d               — last 7 days
 *   maestro timeline --since HEAD~20          — since 20 commits ago
 *   maestro timeline --scope git              — git events only
 *   maestro timeline --scope session          — session events only
 *   maestro timeline --json                   — JSON output
 *   maestro timeline --output report.json     — write to file
 */
import type { Command } from 'commander';
export declare function registerTimelineCommand(program: Command): void;
//# sourceMappingURL=timeline.d.ts.map