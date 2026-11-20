import { Check, Errors } from "typebox/value";

/** Strict format validation only; never grants business completion authority. */
export function describeStructuredOutputValueValidationFailure(
  value: unknown,
  schema: Record<string, unknown>,
): string | undefined {
  try {
    if (Check(schema, value)) return undefined;
    const issue = [...Errors(schema, value)][0] as {
      instancePath?: string;
      schemaPath?: string;
      message?: string;
    } | undefined;
    if (issue) {
      const instancePath = issue.instancePath || "/";
      const schemaPath = issue.schemaPath ? `, schema=${issue.schemaPath}` : "";
      return `structured_output validation failed at ${instancePath}${schemaPath}: ${issue.message ?? "value does not match the schema"}.`;
    }
  } catch (error) {
    return `structured_output validation failed: schema validation could not run (${error instanceof Error ? error.message : String(error)}).`;
  }
  return "structured_output validation failed: value does not match the supplied schema.";
}


export type DeclaredJsonFormatReport =
  | { status: "format_valid"; raw: string; value: unknown }
  | { status: "format_failed"; raw: string; failure: string };

/** Parse the complete declared JSON output, preserving the original evidence. */
export function parseDeclaredJsonResult(
  raw: string,
  schema: Record<string, unknown>,
): DeclaredJsonFormatReport {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {
      status: "format_failed", raw,
      failure: "structured_output validation failed: arguments are not valid JSON.",
    };
  }
  const failure = describeStructuredOutputValueValidationFailure(value, schema);
  return failure === undefined
    ? { status: "format_valid", raw, value }
    : { status: "format_failed", raw, failure };
}
