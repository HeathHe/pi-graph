export type * from "./protocol/spec.ts";
export type * from "./protocol/backend.ts";
export type * from "./protocol/registry.ts";
export type * from "./protocol/ssh.ts";
export { TeammateBackendRegistry, type BackendLoader } from "./registry.ts";
export { resolveBackendConfig, BackendConfigurationError, readBackendFailureEvidence } from "./config.ts";
export { requiredCapabilities, adjudicateTask, validateBackendCapabilities, exactBackendCapabilities, type AdjudicatedTask } from "./capabilities.ts";
export { sanitizedChildEnvironment, targetChildEnvironment, IMMUTABLE_ENV_NAMES, SECRET_ENV_NAME, DEFAULT_ENV_ALLOWLIST, type Environment, type SanitizedChildEnvironmentOptions } from "./child-env.ts";
