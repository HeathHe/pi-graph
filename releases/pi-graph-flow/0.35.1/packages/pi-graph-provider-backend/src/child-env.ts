/** Pure child-environment policy. Reading the process environment belongs to the host. */
export type Environment = Readonly<Record<string, string | undefined>>;

const defaultNames = [
  "COMSPEC", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR", "PATH", "PATHEXT",
  "SYSTEMROOT", "TEMP", "TERM", "TMP", "TMPDIR", "TZ", "USERPROFILE",
] as const;
export const DEFAULT_ENV_ALLOWLIST: ReadonlySet<string> = new Set(defaultNames);
const immutableNames = new Set([
  "COMSPEC", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "LD_LIBRARY_PATH", "LD_PRELOAD",
  "NODE_OPTIONS", "NODE_PATH", "PATH", "PATHEXT", "PERL5LIB", "PYTHONHOME", "PYTHONPATH", "SYSTEMROOT",
]);
export const IMMUTABLE_ENV_NAMES: ReadonlySet<string> = new Set(immutableNames);
const secretNamePattern = /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_?ID)?|ACCESS_?TOKEN|AUTH|BEARER|CREDENTIAL|PASSWORD|PASSWD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/i;

export const SECRET_ENV_NAME = new RegExp(secretNamePattern.source, secretNamePattern.flags);

export interface SanitizedChildEnvironmentOptions {
  allow?: readonly string[];
  additions?: Environment;
  allowSecretAdditions?: boolean;
}

function put(target: Record<string, string>, name: string, value: string): void {
  if (typeof value !== "string" || name.includes("\0") || value.includes("\0")) {
    throw new Error("Child environment entries must be strings without NUL bytes");
  }
  Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
}

export function sanitizedChildEnvironment(
  source: Environment,
  options: SanitizedChildEnvironmentOptions = {},
): Record<string, string> {
  const allow = new Set(options.allow ?? defaultNames);
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || !allow.has(name) || secretNamePattern.test(name)) continue;
    put(result, name, value);
  }
  for (const [name, value] of Object.entries(options.additions ?? {})) {
    if (value === undefined) continue;
    if (!options.allowSecretAdditions && secretNamePattern.test(name)) {
      throw new Error(`Child environment variable ${name} is secret-bearing`);
    }
    if (immutableNames.has(name.toUpperCase())) {
      throw new Error(`Child environment variable ${name} cannot replace launch policy`);
    }
    put(result, name, value);
  }
  return result;
}

/** Only the host may designate trusted target names; no ambient environment lookup. */
export function targetChildEnvironment(
  source: Environment,
  envNames: readonly string[] | undefined,
  additions?: Environment,
  allow?: readonly string[],
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of envNames ?? []) {
    if (!Object.hasOwn(source, name)) continue;
    const value = source[name];
    if (value !== undefined) put(merged, name, value);
  }
  for (const [name, value] of Object.entries(additions ?? {})) {
    if (value !== undefined) put(merged, name, value);
  }
  return sanitizedChildEnvironment(source, { additions: merged, allowSecretAdditions: true, allow });
}
