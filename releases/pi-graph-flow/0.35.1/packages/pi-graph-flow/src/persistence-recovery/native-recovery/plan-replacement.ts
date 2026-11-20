import { fingerprint, assertCounter, type RecoveryHead, type RecoveryContract } from "./contracts.ts";

/** Exact native facts, sampled by the existing owner; never model input. */
export interface NativeBeforePin {
  slot: string; headPresent: boolean; revision: number; headHash: string | null;
  eventHash: string | null; admission: number; ownerGeneration: number;
}
export interface PlanReplacementWitnessRef {
  version: 1; id: string; coordinatorSlot: string; coordinatorRevision: number; digest: string;
}
export interface PlanReplacementIntent {
  replacementId: string; requestDigest: string;
  source: { workspace: string; sessionId: string; anchor: string; prefixIdentityHashes: string[];
    beforeEntryId: string; beforeEntryDigest: string; normalizedBeforeDigest: string };
  predecessor: { groupId: string; groupDigest: string; plan: { handoffKey: string; revision: number; checksum: string } };
  successor: { groupId: string; plan: { handoffKey: string; revision: number; checksum: string } };
  nativeBefore: NativeBeforePin[];
  publication: { state: unknown; contents: Record<string, Record<string, unknown>>; stateDigest: string; semanticDigest: string };
}
export interface PlanReplacementWitness extends PlanReplacementIntent {
  version: 1; reason: "plan-replacement"; id: string;
  members: { slot: string; kind: "supersede" | "create"; before: RecoveryContract | null; after: RecoveryContract;
    beforeRevision: number; beforeHeadHash: string | null; afterRevision: number; admission: number;
    ownerGeneration: number; afterCoreHash: string }[];
}
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
function keys(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Invalid plan replacement evidence fields");
}
export function validateNativeBefore(pins: readonly NativeBeforePin[], slots?: readonly string[]): void {
  if (!Array.isArray(pins) || !pins.length || new Set(pins.map(pin => pin?.slot)).size !== pins.length) throw new Error("Invalid plan replacement native pin set");
  for (const pin of pins) {
    keys(pin, ["slot", "headPresent", "revision", "headHash", "eventHash", "admission", "ownerGeneration"]);
    if (!text(pin.slot) || typeof pin.headPresent !== "boolean") throw new Error("Invalid plan replacement native pin");
    for (const value of [pin.revision, pin.admission, pin.ownerGeneration]) assertCounter(value);
    if (pin.headPresent ? pin.revision < 1 || !hash(pin.headHash) || pin.eventHash !== pin.headHash
      : pin.revision !== 0 || pin.admission !== 0 || pin.ownerGeneration !== 0 || pin.headHash !== null || pin.eventHash !== null) throw new Error("Invalid plan replacement native before evidence");
  }
  if (slots && (slots.length !== pins.length || new Set(slots).size !== slots.length || slots.some((slot, i) => slot !== pins[i]!.slot))) throw new Error("Plan replacement native slots differ");
}
export function planReplacementHeadCoreHash(head: RecoveryHead): string {
  const { planReplacementRecord: _record, planReplacementWitness: _ref, ...core } = head as RecoveryHead & {
    planReplacementRecord?: PlanReplacementWitness; planReplacementWitness?: PlanReplacementWitnessRef;
  };
  return fingerprint(core);
}
export function validatePlanReplacementRef(value: unknown): asserts value is PlanReplacementWitnessRef {
  keys(value, ["version", "id", "coordinatorSlot", "coordinatorRevision", "digest"]);
  const ref = value as PlanReplacementWitnessRef;
  assertCounter(ref.coordinatorRevision);
  if (ref.version !== 1 || !text(ref.id) || !text(ref.coordinatorSlot) || ref.coordinatorRevision < 1 || !hash(ref.digest)) throw new Error("Invalid plan replacement native reference");
}
export function validatePlanReplacementWitness(value: unknown): asserts value is PlanReplacementWitness {
  keys(value, ["version", "reason", "id", "replacementId", "requestDigest", "source", "predecessor", "successor", "nativeBefore", "publication", "members"]);
  const w = value as PlanReplacementWitness;
  if (w.version !== 1 || w.reason !== "plan-replacement" || !text(w.id) || !text(w.replacementId) || !hash(w.requestDigest)) throw new Error("Invalid plan replacement witness identity");
  keys(w.source, ["workspace", "sessionId", "anchor", "prefixIdentityHashes", "beforeEntryId", "beforeEntryDigest", "normalizedBeforeDigest"]);
  if (![w.source.workspace, w.source.sessionId, w.source.anchor, w.source.beforeEntryId].every(text)
    || !Array.isArray(w.source.prefixIdentityHashes) || !w.source.prefixIdentityHashes.length || !w.source.prefixIdentityHashes.every(hash)
    || !hash(w.source.beforeEntryDigest) || !hash(w.source.normalizedBeforeDigest)) throw new Error("Invalid plan replacement witness source");
  keys(w.predecessor, ["groupId", "groupDigest", "plan"]); keys(w.successor, ["groupId", "plan"]);
  if (!text(w.predecessor.groupId) || !hash(w.predecessor.groupDigest) || !text(w.successor.groupId) || w.successor.groupId === w.predecessor.groupId) throw new Error("Invalid plan replacement witness groups");
  for (const plan of [w.predecessor.plan, w.successor.plan]) {
    keys(plan, ["handoffKey", "revision", "checksum"]); assertCounter(plan.revision);
    if (!text(plan.handoffKey) || !hash(plan.checksum)) throw new Error("Invalid plan replacement witness approval");
  }
  if (w.successor.plan.revision <= w.predecessor.plan.revision || w.successor.plan.handoffKey === w.predecessor.plan.handoffKey) throw new Error("Plan replacement approval did not advance");
  keys(w.publication, ["state", "contents", "stateDigest", "semanticDigest"]);
  if (!hash(w.publication.stateDigest) || !hash(w.publication.semanticDigest) || fingerprint(w.publication.state) !== w.publication.stateDigest
    || !w.publication.contents || typeof w.publication.contents !== "object" || Array.isArray(w.publication.contents)) throw new Error("Invalid plan replacement witness publication");
  for (const [ref, content] of Object.entries(w.publication.contents)) if (!hash(ref) || fingerprint(content) !== ref) throw new Error("Invalid plan replacement witness content");
  if (!Array.isArray(w.members) || !w.members.some(member => member?.kind === "supersede") || !w.members.some(member => member?.kind === "create")) throw new Error("Incomplete plan replacement native batch");
  validateNativeBefore(w.nativeBefore, w.members.map(member => member.slot));
  for (const [i, member] of w.members.entries()) {
    keys(member, ["slot", "kind", "before", "after", "beforeRevision", "beforeHeadHash", "afterRevision", "admission", "ownerGeneration", "afterCoreHash"]);
    const pin = w.nativeBefore[i]!;
    if (!["supersede", "create"].includes(member.kind) || member.beforeRevision !== pin.revision || member.beforeHeadHash !== pin.headHash
      || member.afterRevision !== pin.revision + 1 || member.admission !== pin.admission + 1 || member.ownerGeneration !== pin.ownerGeneration + 1
      || !hash(member.afterCoreHash) || (member.kind === "create" ? member.before !== null || pin.headPresent : !member.before)) throw new Error("Invalid plan replacement native member");
    for (const count of [member.afterRevision, member.admission, member.ownerGeneration]) assertCounter(count);
    for (const contract of [member.before, member.after]) {
      if (!contract) continue;
      assertCounter(contract.version);
      if (contract.taskId !== member.slot || !text(contract.instanceId) || !hash(contract.digest) || contract.inputDigest !== fingerprint(contract.input)
        || contract.source.workspace !== w.source.workspace || contract.source.sessionId !== w.source.sessionId || contract.source.branchAnchor !== w.source.anchor) throw new Error("Invalid plan replacement native contract");
    }
    if (!member.after || member.before && member.after.instanceId !== member.before.instanceId) throw new Error("Plan replacement changed predecessor identity");
  }
}
