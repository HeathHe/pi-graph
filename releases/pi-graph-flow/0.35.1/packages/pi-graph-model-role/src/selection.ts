import { createHash } from "node:crypto";
import { isRegisteredModelId } from "./model-catalog.ts";

export interface RoleSnapshot {
  role: string;
  revision: string;
  candidates: readonly string[];
  /** Explicit provider fence, when the role authority declares one. */
  fixedProvider?: string;
}
export interface EligibilitySnapshot {
  revision: string;
  state: "known" | "unknown";
  modelIds: readonly string[];
  /** Host supplies this only after parsing a trusted registry projection.
   * Registration names are opaque IDs, not evidence of an upstream provider. */
  identity?: {kind: "native"} | {kind: "registered"; projectionHash: string};
}
export interface TaskSelectionDefaults {
  model?: string | null;
  fallbackModels?: readonly string[] | null;
}
export interface SelectionRequest {
  model?: string;
  fallbackModels?: readonly string[];
  /** Legacy ordered task default, not an additional authority or intersection. */
  taskModels?: readonly string[];
  /** Separate fields retain missing/null versus an explicit empty fallback list. */
  taskDefaults?: TaskSelectionDefaults;
  /** A pure host adapter; only adopted fields are resolved, then checked against the role. */
  canonicalizeModel?: (model: string) => string;
}
export interface SelectionDecision {
  readonly version: 1;
  readonly role: string;
  readonly roleRevision: string;
  readonly roleHash: string;
  readonly catalogRevision: string;
  readonly catalogHash: string;
  readonly selected: string;
  readonly candidates: readonly string[];
  readonly reason: "single-role-model" | "explicit-role-subset" | "first-eligible-role-model";
  /** This is permission/selection evidence, never actual upstream execution evidence. */
  readonly actual: "unknown";
}
export function snapshotHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export function modelReference(value: string): { provider: string; id: string } | undefined {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1 || /[\s\x00-\x1f\x7f]/.test(value)) return undefined;
  return { provider: value.slice(0, slash), id: value.slice(slash + 1) };
}
function fail(message: string): never { throw new Error(`ModelRole: ${message}`); }
function identity(role: RoleSnapshot, catalog: EligibilitySnapshot) {
  return { role: role.role, roleRevision: role.revision, roleHash: snapshotHash(role),
    catalogRevision: catalog.revision, catalogHash: snapshotHash(catalog) };
}
const issued = new WeakSet<object>();
export function selectModel(role: RoleSnapshot, catalog: EligibilitySnapshot, request: SelectionRequest = {}): SelectionDecision {
  if (catalog.state !== "known") fail("catalog is unknown");
  if (!catalog.modelIds.length) fail("catalog is known empty");
  if (!role.candidates.length) fail("role has zero candidates");
  if (request.taskDefaults !== undefined && request.taskModels !== undefined) fail("ambiguous task defaults");
  const defaults = request.taskDefaults ?? (request.taskModels === undefined ? undefined
    : { model: request.taskModels[0], fallbackModels: request.taskModels.slice(1) });
  if (request.model === undefined && request.taskModels?.length === 0) fail("zero eligible role candidates");
  const resolve = request.canonicalizeModel ?? ((model: string) => model);
  const primary = resolve(request.model ?? defaults?.model ?? role.candidates[0]!);
  const fallbacks = request.fallbackModels ?? defaults?.fallbackModels ?? role.candidates.slice(1);
  const requested = [primary, ...fallbacks.map(resolve)];
  const allowed = new Set(role.candidates);
  for (const id of requested) {
    if (!allowed.has(id)) fail(`candidate is outside role ${role.role}`);
  }
  const candidates = [...new Set(requested)].filter(id => catalog.modelIds.includes(id));
  if (request.model !== undefined && !candidates.includes(primary)) fail("explicit model is unavailable");
  for (const id of candidates) {
    if (catalog.identity?.kind === "registered") {
      if (!catalog.identity.projectionHash || !isRegisteredModelId(id)) fail("invalid registered identity snapshot");
      if (role.fixedProvider !== undefined) fail("registered provider identity is unknown for fixed provider fence");
    } else {
      const reference = modelReference(id);
      if (!reference) fail("candidate is not an exact provider/model identity");
      if (role.fixedProvider !== undefined && reference.provider !== role.fixedProvider) fail("fixed provider mismatch");
    }
  }
  if (!candidates.length) fail("zero eligible role candidates");
  const decision: SelectionDecision = Object.freeze({ version: 1, ...identity(role, catalog),
    selected: candidates[0]!, candidates: Object.freeze(candidates), actual: "unknown",
    reason: request.model !== undefined || request.taskModels !== undefined
      || defaults?.model != null || defaults?.fallbackModels != null ? "explicit-role-subset"
      : role.candidates.length === 1 ? "single-role-model" : "first-eligible-role-model" });
  issued.add(decision);
  return decision;
}
/** Admission verifies the original decision. It does not invoke selection or substitute a model. */
export function verifySelection(decision: SelectionDecision, role: RoleSnapshot, catalog: EligibilitySnapshot,
  selected: string | undefined, fallbacks: readonly string[] | undefined): void {
  if (!issued.has(decision)) fail("untrusted selection decision");
  const expected = identity(role, catalog);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (decision[key] !== expected[key]) fail("selection snapshot changed before admission");
  }
  if (selected !== decision.selected || JSON.stringify(fallbacks ?? []) !== JSON.stringify(decision.candidates.slice(1))) {
    fail("launch parameters differ from frozen decision");
  }
}
export function providerFallbackAllowed(reason: "provider-unavailable" | "tool-error" | "cancelled" | "quality" | "unknown"): boolean {
  return reason === "provider-unavailable";
}
