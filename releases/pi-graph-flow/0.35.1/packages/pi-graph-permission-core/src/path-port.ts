/** Host supplies real Node path operations, never a lexical-only imitation. */
export interface PermissionPathApi {
  readonly sep: string;
  normalize(value: string): string;
  resolve(...values: string[]): string;
  isAbsolute(value: string): boolean;
  parse(value: string): { root: string };
  join(...values: string[]): string;
  dirname(value: string): string;
  basename(value: string): string;
  relative(from: string, to: string): string;
}
export interface PermissionPathPort {
  readonly posix: PermissionPathApi;
  readonly win32: PermissionPathApi;
  readonly nativeFlavor: "posix" | "win32";
  /** Exact realpathSync.native semantics: throws on failure, no invented fallback. */
  realpathNative(value: string): string;
}
