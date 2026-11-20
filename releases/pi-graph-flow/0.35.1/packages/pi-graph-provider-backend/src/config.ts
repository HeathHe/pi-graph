import type {
  BackendConfigField,
  ConfigValue,
  ResolvedBackendConfig,
  TeammateBackend,
} from "./protocol/backend.ts";

/** Evidence is deliberately absent from public error properties and messages. */
const evidence = new WeakMap<object, unknown>();

export class BackendConfigurationError extends Error {
  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "BackendConfigurationError";
    if (detail !== undefined) evidence.set(this, detail);
  }
}

/** Explicit diagnostic port: callers must not publish the returned private evidence. */
export function readBackendFailureEvidence(value: object): unknown {
  return evidence.get(value);
}

function defineValue(target: Record<string, ConfigValue>, key: string, value: ConfigValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function copyValue(value: unknown): ConfigValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every(item => typeof item === "string")) return [...value];
  throw new BackendConfigurationError("Backend configuration contains an invalid value type");
}

/** Own-key copy; no caller or resolver can mutate an admitted array later. */
export function snapshotConfig(input: unknown): Record<string, ConfigValue> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new BackendConfigurationError("Backend configuration must be an object");
  }
  const result: Record<string, ConfigValue> = {};
  for (const key of Object.keys(input)) {
    const value = copyValue((input as Record<string, unknown>)[key]);
    defineValue(result, key, Array.isArray(value) ? Object.freeze(value) : value);
  }
  return Object.freeze(result);
}

function validateField(field: BackendConfigField, value: unknown): string | undefined {
  switch (field.kind) {
    case "text":
    case "path":
    case "credential-ref":
    case "dynamic-enum":
      return typeof value === "string" ? undefined : "expected a string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? undefined : "expected an integer";
    case "number":
      // Preserve the pre-migration numeric policy, including NaN and Infinity.
      return typeof value === "number" ? undefined : "expected a number";
    case "boolean":
      return typeof value === "boolean" ? undefined : "expected a boolean";
    case "string-list":
      return Array.isArray(value) && value.every(item => typeof item === "string")
        ? undefined : "expected an array of strings";
    case "enum":
      if (typeof value !== "string") return "expected a string";
      if (!field.options?.length) return "declares an enum without options";
      return field.options.some(option => option.value === value) ? undefined : "expected a declared enum option";
  }
}

function publicResult(
  values: Record<string, ConfigValue>,
  errors: string[],
  warnings?: string[],
  detail?: unknown,
): ResolvedBackendConfig {
  const result: ResolvedBackendConfig = {
    values: snapshotConfig(values),
    errors: Object.freeze([...errors]),
    ...(warnings === undefined ? {} : { warnings: Object.freeze([...warnings]) }),
  };
  if (detail !== undefined) evidence.set(result, detail);
  return Object.freeze(result);
}

export function resolveBackendConfig<TPlacement = unknown>(
  backend: TeammateBackend<TPlacement>,
  config: Record<string, ConfigValue> = {},
): ResolvedBackendConfig {
  const fields = backend.configFields ?? [];
  const errors: string[] = [];
  if (fields.length === 0) {
    for (const key of Object.keys(config)) errors.push(`backend "${backend.name}" accepts no setting "${key}"`);
    return publicResult({}, errors);
  }
  if (typeof backend.resolveConfig !== "function") {
    return publicResult({}, [`backend "${backend.name}" declares configuration without resolveConfig`]);
  }
  if (fields.some(field => field.kind === "dynamic-enum") && typeof backend.listConfigOptions !== "function") {
    return publicResult({}, [`backend "${backend.name}" declares dynamic-enum without listConfigOptions`]);
  }
  const declared = new Map(fields.map(field => [field.key, field]));
  for (const key of Object.keys(config)) {
    if (!declared.has(key)) errors.push(`backend "${backend.name}" has no setting "${key}"`);
  }
  const values: Record<string, ConfigValue> = {};
  for (const field of fields) {
    const raw = Object.hasOwn(config, field.key) ? config[field.key] : undefined;
    if (raw === undefined) {
      if (field.default !== undefined) defineValue(values, field.key, copyValue(field.default));
      else if (field.required) errors.push(`backend "${backend.name}" requires setting "${field.key}"`);
      continue;
    }
    const failure = validateField(field, raw);
    if (failure !== undefined) errors.push(`backend "${backend.name}" setting "${field.key}": ${failure}`);
    else defineValue(values, field.key, copyValue(raw));
  }
  if (errors.length > 0) return publicResult(values, errors);

  let resolved: ResolvedBackendConfig;
  try {
    // A detached mutable input preserves resolvers that normalize in place.
    resolved = backend.resolveConfig(values);
  } catch (cause) {
    throw new BackendConfigurationError(`backend "${backend.name}" configuration resolver failed`, cause);
  }
  if (!resolved || typeof resolved !== "object" || !Array.isArray(resolved.errors)
      || !resolved.errors.every(item => typeof item === "string")
      || (resolved.warnings !== undefined && (!Array.isArray(resolved.warnings)
        || !resolved.warnings.every(item => typeof item === "string")))) {
    throw new BackendConfigurationError(`backend "${backend.name}" returned an invalid configuration result`, resolved);
  }
  const safeErrors = resolved.errors.map(() => `backend "${backend.name}" rejected its configuration`);
  return publicResult(resolved.values, safeErrors, resolved.warnings === undefined ? undefined : [...resolved.warnings],
    resolved.errors.length > 0 ? [...resolved.errors] : undefined);
}
