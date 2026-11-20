/**
 * Migration: v1.0 → v2.0 — Artifact Registry
 *
 * Converts phase-directory model to scratch-based artifact registry.
 * Harvests existing artifacts from .workflow/phases/ into state.json.artifacts[].
 */
import type { MigrationDef } from '../utils/migration-registry.js';
declare const migration: MigrationDef;
export default migration;
//# sourceMappingURL=v1-to-v2.d.ts.map