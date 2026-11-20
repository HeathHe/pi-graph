import { type MemberRecord } from '../tools/team-members.js';
import { type ActivityEvent } from '../tools/team-activity.js';
export interface PreflightResult {
    exitCode: 0 | 1 | 2;
    warnings: string[];
    conflicts: Array<{
        user: string;
        host: string;
        action: string;
        ts: string;
        relative: string;
    }>;
}
export interface PreflightDeps {
    getSelf?: () => MemberRecord | null;
    getActivity?: (mins: number) => ActivityEvent[];
    now?: () => number;
}
/**
 * Pure preflight logic — detects whether other team members are active on
 * the given phase within a look-back window.
 *
 * Algorithm:
 *   1. If no self → exit 0 (team mode off is a safe no-op).
 *   2. Fetch recent activity (30 min window, clock tolerance handled by
 *      team-activity module).
 *   3. Filter: same phase, different user.
 *   4. Deduplicate by `user@host` keeping the most recent event.
 *   5. Emit one warning line per unique teammate.
 *
 * `force` affects ONLY the exit code — warnings are still returned so
 * callers can display them.
 */
export declare function runPreflight(phase: number, opts: {
    force?: boolean;
}, deps?: PreflightDeps): PreflightResult;
//# sourceMappingURL=preflight-core.d.ts.map