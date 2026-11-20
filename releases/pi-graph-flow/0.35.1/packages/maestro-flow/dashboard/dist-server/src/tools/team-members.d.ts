/**
 * Human-team member registry (team-lite collaboration, Wave 2).
 *
 * Owns `.workflow/collab/members/{uid}.json` — per-file member records.
 *
 * Strict namespace separation: this module belongs to the HUMAN collaboration
 * domain (`.workflow/collab/`). It must NEVER touch `.workflow/.team/` which
 * is the agent pipeline message bus owned by `src/tools/team-msg.ts`.
 *
 * Per-file layout is deliberate: each member writes their own JSON file so
 * two concurrent `maestro team join` on different machines never collide on
 * git merge (vs. a single `members.json` which cannot `merge=union`).
 */
export type ProjectRole = string;
export interface MemberRecord {
    uid: string;
    name: string;
    email: string;
    host: string;
    role: 'admin' | 'member';
    joinedAt: string;
    projectRoles?: ProjectRole[];
}
/** Absolute path to the human-collab members directory. */
export declare function getMembersDir(): string;
/**
 * Resolve local git identity via `git config user.name` / `user.email`.
 * Returns null if either is missing or git is unavailable.
 */
export declare function readGitIdentity(): {
    name: string;
    email: string;
} | null;
/**
 * Derive a uid from an email address.
 *
 * Rule: take the local-part (before '@'), lowercase it.
 *   "Alice@Example.COM" -> "alice"
 *
 * Collision handling is NOT done here — callers must check `getMembersDir`
 * and append `-2`, `-3`, ... as needed (see `joinTeam`).
 */
export declare function deriveUid(email: string): string;
/** Return the machine hostname. Exported so tests can stub if needed. */
export declare function getHost(): string;
/**
 * List all known members. Returns an empty array if the directory does not
 * exist yet. Files that fail to parse as `MemberRecord` JSON are skipped
 * silently — corrupt files should not break `whoami` / `status`.
 */
export declare function listMembers(): MemberRecord[];
/** Read a single member by uid, or null if the file does not exist. */
export declare function getMemberByUid(uid: string): MemberRecord | null;
/**
 * Return the member record matching the current git identity.
 *
 * Matching uses `email` (case-insensitive), NOT just `uid`, so two users who
 * happened to get the same local-part on different domains still resolve to
 * their own record.
 *
 * Returns null if git identity is unavailable or no record matches.
 */
export declare function resolveSelf(): MemberRecord | null;
/**
 * Assert that team mode is active (i.e. the current git user has a member
 * record). Throws a descriptive error if `resolveSelf()` returns null.
 *
 * Returns the resolved `MemberRecord` for convenience so callers can chain:
 *   const self = requireTeamMode();
 */
export declare function requireTeamMode(): MemberRecord;
/**
 * Assert the current user holds the given role. Calls `resolveSelf()`
 * internally, so it also fails when team mode is off.
 *
 * Throws with a message like:
 *   "This operation requires admin role. Your role: member"
 */
export declare function requireRole(required: 'admin' | 'member'): MemberRecord;
/**
 * Join the team. Idempotent.
 *
 * Flow:
 *   1. Read git identity (throws if name/email missing — cannot join without it).
 *   2. If a record with the same email already exists, return it unchanged
 *      (preserves `joinedAt` and any prior `role`).
 *   3. Derive uid from email local-part. If another member with a different
 *      email already owns that uid, append `-2`, `-3`, ... until free.
 *   4. Assign role: explicit `opts.role` wins; otherwise the very first member
 *      to join becomes `admin`, everyone after is `member`.
 *   5. Write `.workflow/collab/members/{uid}.json` atomically via `writeFileSync`.
 */
export declare function joinTeam(opts?: {
    role?: 'admin' | 'member';
}): MemberRecord;
/**
 * Add a project role to a member's record. Idempotent — adding a role that
 * already exists is a no-op. Returns the updated record, or null if the
 * member was not found.
 */
export declare function addProjectRole(uid: string, role: string): MemberRecord | null;
/**
 * Remove a project role from a member's record. No-op if the role is not
 * present. Returns the updated record, or null if the member was not found.
 */
export declare function removeProjectRole(uid: string, role: string): MemberRecord | null;
/**
 * List project roles. When `uid` is provided, returns that member's roles
 * (or an empty array). When omitted, returns a Map of all members' roles.
 */
export declare function listProjectRoles(uid?: string): ProjectRole[] | Map<string, ProjectRole[]>;
