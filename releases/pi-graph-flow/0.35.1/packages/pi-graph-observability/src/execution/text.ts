import { Buffer } from "node:buffer";
import type { ObserveResult } from "./contracts.ts";
export const WATCH_MAX_TRANSITIONS = 128;
export const WATCH_MAX_TRANSITION_BYTES = 256 * 1024;
export const OBSERVATION_TEXT_MAX_BYTES = 32 * 1024;
const DISPLAY_TRUNCATED = "[observation text truncated; canonical result unchanged]";

function utf8Head(text: string, bytes: number): string {
  const encoded = Buffer.from(text.slice(0, bytes), "utf8");
  let end = Math.min(bytes, encoded.length);
  // A cut inside a multibyte sequence retreats to its leading byte.
  while (end > 0 && end < encoded.length && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}

/** Display-only bound, including separators and the truncation notice. */
export function boundObservationText(lines: Iterable<string>): string[] {
  const maxBytes = OBSERVATION_TEXT_MAX_BYTES;
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const nextBytes = bytes + (kept.length ? 1 : 0) + Buffer.byteLength(line, "utf8");
    if (nextBytes > maxBytes) {
      const prefix = utf8Head([...kept, line.slice(0, maxBytes)].join("\n"),
        Math.max(0, maxBytes - Buffer.byteLength(DISPLAY_TRUNCATED) - 1));
      return `${prefix}\n${DISPLAY_TRUNCATED}`.split("\n");
    }
    kept.push(line);
    bytes = nextBytes;
  }
  return kept;
}

/** Compact, bounded display serialization; never alters the canonical value. */
export function observationJson(value: unknown, maxBytes = OBSERVATION_TEXT_MAX_BYTES): string | undefined {
  const limit = {};
  let budget = maxBytes;
  let nodes = 0;
  const ancestors: unknown[] = [];
  try {
    const text = JSON.stringify(value, function (key, item) {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (++nodes > maxBytes || ancestors.length > 64) throw limit;
      budget -= Buffer.byteLength(key, "utf8") + 4;
      budget -= typeof item === "string" ? Buffer.byteLength(item, "utf8") : 8;
      if (budget < 0) throw limit;
      if (item !== null && typeof item === "object") ancestors.push(item);
      return item;
    });
    return text !== undefined && Buffer.byteLength(text, "utf8") <= maxBytes ? text : undefined;
  } catch (error) {
    return error === limit ? undefined : "(not JSON-serializable)";
  }
}

const LAST_RESULT_EXCERPT_CHARS = 240;

/** One line of a result, whitespace flattened and cut to the excerpt bound. */
function lastResultExcerpt(text: string): string {
  const flattened = text.replaceAll(/\s+/gu, " ").trim();
  return flattened.length <= LAST_RESULT_EXCERPT_CHARS
    ? flattened
    : `${flattened.slice(0, LAST_RESULT_EXCERPT_CHARS)}…`;
}

export function formatObserveResult<D>(result: ObserveResult<D>, verbose = false, renderDiagnosis?: (diagnosis: D) => string[]): string[] {
  const observations = result.evictedTransitions ? result.latestObservations ?? result.observations : result.observations;
  const targetCount = result.latestObservations?.length ?? result.observations.length;
  function* render(): Generator<string> {
    yield `${targetCount} targets: ${result.reason} (${result.durationMs}ms)`;
    if (result.evictedTransitions) {
      yield `[watch history truncated: ${result.evictedTransitions} transitions evicted; showing latest snapshots]`;
    }
    for (const observation of observations) {
      const label = `${observation.target.kind}:${observation.target.id}`;
      yield `${label}\t${observation.nativeStatus}\t${observation.summary}`.trimEnd();
      if (observation.diagnosis) {
        yield "  --- diagnosis ---";
        for (const line of renderDiagnosis?.(observation.diagnosis) ?? []) yield `  ${line}`;
      }
      if (verbose && observation.detail) {
        for (const detail of observation.detail) yield `  ${detail}`;
      }
      const detailHasLastResult = observation.detail?.includes("--- last result ---") === true;
      // Render the target's own account, not just inferred status/idle counts.
      if (observation.lastResult && !detailHasLastResult) {
        if (verbose) {
          yield "  --- last result ---";
          for (const line of observation.lastResult.split("\n")) yield `  ${line}`;
        } else {
          yield `  result: ${lastResultExcerpt(observation.lastResult)}`;
        }
      }
      const detailHasStructuredOutput = observation.detail?.includes("--- structured output ---") === true;
      if (verbose && observation.structuredOutput !== undefined && !detailHasStructuredOutput) {
        yield "  --- structured output ---";
        yield `  ${observationJson(observation.structuredOutput) ?? "[structured output omitted: display budget exceeded; canonical value unchanged]"}`;
      }
    }
  }
  return boundObservationText(render());
}

