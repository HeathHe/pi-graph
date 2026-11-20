import { createHash, randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeEvidenceRefs, resolveGoalEvidenceUri, type GoalEvidenceRef } from "../tools/goal-evidence.ts";
import type { GoalContext } from "../tools/goal.ts";
import { redactSecrets } from "./redaction.ts";
export const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
export type MaterialReviewContext = Pick<GoalContext,"cwd"|"sessionManager">;
export interface CriterionAssessment {
  criterion: string;
  satisfied: boolean;
  reason: string;
  evidence: { ref: number; observedText: string }[];
}
/** Judgment submitted by the root. This is not a report or a verification token. */
export interface MaterialReviewInput { evidenceRefs: GoalEvidenceRef[]; assessments: CriterionAssessment[]; }
export interface MaterialFingerprint { ref: GoalEvidenceRef; canonical: string; fingerprint: string; }
export interface MaterialReviewReport {
  id: string; issuer: "host"; method: "manual-observed"; issuedAt: number;
  contractDigest: string; source: { cwd: string; sessionId: string; branchAnchor: string };
  materials: MaterialFingerprint[];
  criteria: CriterionAssessment[];
  accepted: boolean;
}
const issued = new Map<string, string>();
const invalidationListeners=new Set<()=>void>();
export function subscribeMaterialReviewInvalidation(listener:()=>void):()=>void {invalidationListeners.add(listener);return ()=>{invalidationListeners.delete(listener);};}
export function invalidateMaterialReviews(): void { issued.clear(); }
export function materialReviewValidationError(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "review must contain original evidenceRefs and per-criterion assessments.";
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !["evidenceRefs", "assessments"].includes(key))) return "review cannot supply a report, pass flag, or host identity.";
  try { if (!normalizeEvidenceRefs(record.evidenceRefs)?.length) return "review requires at least one original evidence reference."; } catch (error) { return String(error); }
  if (!Array.isArray(record.assessments) || !record.assessments.length || record.assessments.length > 16) return "review requires 1..16 assessments.";
  for (const raw of record.assessments) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "Invalid criterion assessment.";
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some(key => !["criterion", "satisfied", "reason", "evidence"].includes(key))
      || typeof item.criterion !== "string" || !item.criterion.trim() || item.criterion.length > 2048
      || typeof item.satisfied !== "boolean" || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 4000
      || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 16) return "Each criterion needs a judgment, specific reason, and evidence excerpts.";
    for (const rawExcerpt of item.evidence) {
      if (!rawExcerpt || typeof rawExcerpt !== "object") return "Invalid evidence excerpt.";
      const excerpt = rawExcerpt as Record<string, unknown>;
      if (Object.keys(excerpt).some(key => !["ref", "observedText"].includes(key)) || !Number.isSafeInteger(excerpt.ref)
        || (excerpt.ref as number) < 0 || (excerpt.ref as number) >= (record.evidenceRefs as unknown[]).length
        || typeof excerpt.observedText !== "string" || !excerpt.observedText.trim() || excerpt.observedText.length > 4000) return "Evidence excerpt must identify a reference and 1..4000 actually observed characters.";
    }
  }
  return undefined;
}
async function readMaterial(ref: GoalEvidenceRef, ctx: MaterialReviewContext, assertCurrent: () => void): Promise<{ material: MaterialFingerprint; text: string }> {
  assertCurrent();
  let canonical: string, text: string, fingerprint: string;
  if (ref.path) {
    canonical = await realpath(resolve(ctx.cwd, ref.path)); assertCurrent();
    const file = await open(canonical, "r");
    try {
      const before = await file.stat(); assertCurrent();
      if (!before.isFile() || before.size > 2_000_000) throw new Error("Evidence must be a regular file <= 2 MB; use a bounded original artifact.");
      const bytes = await file.readFile(); assertCurrent();
      const after = await file.stat(); assertCurrent();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || await realpath(resolve(ctx.cwd, ref.path)) !== canonical) throw new Error("Evidence changed while it was read.");
      fingerprint = digest(bytes.toString("base64"));
      text = redactSecrets(bytes.toString("utf8").split(/\r?\n/).slice((ref.offset ?? 1) - 1, (ref.offset ?? 1) - 1 + (ref.limit ?? 200)).join("\n"));
    } finally { await file.close(); }
  } else {
    const result = await resolveGoalEvidenceUri(ref.uri!, ctx, ref, undefined, redactSecrets); assertCurrent();
    canonical = result.canonicalUri ?? ref.uri!; text = result.content;
    fingerprint = digest([canonical, text]);
    if (ref.uri!.startsWith("agent://") && !result.canonicalUri) throw new Error("Evidence publication cannot be pinned.");
  }
  assertCurrent();
  if (!text.trim() || text.length > 128_000) throw new Error("Evidence page is empty or too large; select an exact page.");
  return { material: { ref: structuredClone(ref), canonical, fingerprint }, text };
}
export async function issueMaterialReview(input: MaterialReviewInput, criteria: readonly string[], contractDigest: string,
  ctx: MaterialReviewContext, source: MaterialReviewReport["source"], assertCurrent: () => void): Promise<MaterialReviewReport> {
  const error = materialReviewValidationError(input); if (error) throw new Error(error);
  const refs = normalizeEvidenceRefs(input.evidenceRefs)!;
  if (new Set(criteria).size !== criteria.length || input.assessments.length !== criteria.length
    || new Set(input.assessments.map(item => item.criterion)).size !== criteria.length
    || criteria.some(criterion => !input.assessments.some(item => item.criterion === criterion))) throw new Error("Every current acceptance criterion must be reviewed exactly once.");
  const read = [];
  for (const ref of refs) read.push(await readMaterial(ref, ctx, assertCurrent));
  for (const item of input.assessments) for (const excerpt of item.evidence) {
    if (!read[excerpt.ref]!.text.includes(excerpt.observedText) || excerpt.observedText.includes("[REDACTED]")) throw new Error(`Criterion ${item.criterion}: quoted evidence was not observed in the selected original material.`);
  }
  const report: MaterialReviewReport = { id: randomUUID(), issuer: "host", method: "manual-observed", issuedAt: Date.now(), contractDigest,
    source: structuredClone(source), materials: read.map(item => item.material), criteria: structuredClone(input.assessments), accepted: input.assessments.every(item => item.satisfied) };
  await recheckMaterialReview(report, ctx, assertCurrent, false);
  issued.set(report.id, digest(report)); return report;
}
/** Persisted reports are descriptive history after restart. Re-review existing material; never rerun business work. */
export function assertIssuedMaterialReview(report: MaterialReviewReport): void {
  if (issued.get(report.id) !== digest(report)) throw new Error("pending-review: report is not currently host-issued; review the original evidence again.");
}
export async function recheckMaterialReview(report: MaterialReviewReport, ctx: MaterialReviewContext, assertCurrent: () => void, requireIssued = true): Promise<void> {
  if (requireIssued) assertIssuedMaterialReview(report);
  try {
    for (const expected of report.materials) {
      const { material } = await readMaterial(expected.ref, ctx, assertCurrent);
      if (material.canonical !== expected.canonical || material.fingerprint !== expected.fingerprint) throw new Error("pending-review: original evidence material changed after review.");
    }
    assertCurrent();
  } catch(error) {
    // An observed failed recheck revokes current authority immediately. Metadata is projected later by its owner.
    if(issued.delete(report.id))for(const listener of invalidationListeners){try{listener();}catch{/* observers grant no authority */}}
    throw error;
  }
}
