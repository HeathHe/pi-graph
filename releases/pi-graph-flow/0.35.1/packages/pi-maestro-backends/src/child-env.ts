import {
  sanitizedChildEnvironment as sanitizeCoreEnvironment,
  targetChildEnvironment as targetCoreEnvironment,
  IMMUTABLE_ENV_NAMES as coreImmutableNames,
} from "pi-graph-provider-backend/child-env";

export { SECRET_ENV_NAME } from "pi-graph-provider-backend/child-env";
export const IMMUTABLE_ENV_NAMES = new Set(coreImmutableNames);

export interface SanitizedChildEnvironmentOptions {
  source?: NodeJS.ProcessEnv;
  allow?: readonly string[];
  additions?: Readonly<Record<string, string | undefined>>;
  allowSecretAdditions?: boolean;
}

/** Only this host seam reads the process environment; policy has one core owner. */
export function sanitizedChildEnvironment(options: SanitizedChildEnvironmentOptions = {}): NodeJS.ProcessEnv {
  return sanitizeCoreEnvironment(options.source ?? process.env, options);
}

export function targetChildEnvironment(
  envNames: readonly string[] | undefined,
  additions?: Readonly<Record<string, string | undefined>>,
  allow?: readonly string[],
): NodeJS.ProcessEnv {
  return targetCoreEnvironment(process.env, envNames, additions, allow);
}
