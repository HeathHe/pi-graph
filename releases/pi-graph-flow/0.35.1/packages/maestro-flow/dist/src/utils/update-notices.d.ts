/**
 * update-notices.ts — Version-keyed update notices for `maestro update`.
 *
 * Each notice describes what a release introduced and (optionally) interactive
 * actions the user can run after upgrading. The framework is invoked by
 * `maestro update` post-`npm install` so the running code is from the NEW
 * binary, ensuring the latest notice registry is loaded.
 *
 * Registry pattern mirrors migration-registry.ts. New notices are appended
 * at the bottom of this file and run automatically for any user whose old
 * version is below the notice's `version` field.
 */
export interface NoticeAction {
    /** Stable id (used in logs / skip lists). */
    id: string;
    /** One-line description shown to the user / used as prompt text. */
    description: string;
    /** Run without prompting when true. Use sparingly for non-destructive ops. */
    auto?: boolean;
    /** Default response when prompting (true = "Y/n", false = "y/N"). */
    defaultYes?: boolean;
    /** Returns a short summary line on success. Throw to mark as failed. */
    run: (ctx: NoticeContext) => Promise<string> | string;
}
export interface UpdateNotice {
    /** Version that introduced this notice (e.g. "0.4.9"). */
    version: string;
    /** Short title for the section header. */
    title: string;
    /** 1-5 short bullets shown before the actions. */
    highlights: string[];
    /** Interactive or auto actions to perform on upgrade. */
    actions: NoticeAction[];
}
export interface NoticeContext {
    fromVersion: string;
    toVersion: string;
    /** Whether the parent flow is non-interactive (CI/scripts). */
    nonInteractive: boolean;
}
export interface NoticeRunOptions {
    /** Don't execute actions, just print what would run. */
    dryRun?: boolean;
    /** Skip prompts; use each action's `defaultYes` value. */
    nonInteractive?: boolean;
}
export declare function registerNotice(notice: UpdateNotice): void;
export declare function listNotices(): readonly UpdateNotice[];
/**
 * Return notices that apply to the upgrade range (fromVersion, toVersion].
 * Pass an empty fromVersion ("" or "0.0.0") to list everything up to toVersion.
 */
export declare function planNotices(fromVersion: string, toVersion?: string): UpdateNotice[];
/** Render the plan to stderr (header + highlights, no execution). */
export declare function printNoticePlan(plan: UpdateNotice[]): void;
/**
 * Execute each notice's actions in order. Prompts the user for non-auto
 * actions unless opts.nonInteractive is true. Failures are logged but never
 * abort the loop — the rest of the notices still get a chance to run.
 */
export declare function applyNotices(plan: UpdateNotice[], fromVersion: string, toVersion: string, opts?: NoticeRunOptions): Promise<void>;
//# sourceMappingURL=update-notices.d.ts.map