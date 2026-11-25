#!/usr/bin/env node
/**
 * sync-pi.mjs — One-shot sync of the pi-graph skill/agent mirror.
 *
 * Runs the full 3-phase conversion pipeline that ports the Claude harness
 * (D:/maestro2/.claude) into the pi build output (.pi-sync/), then verifies that
 * every skill subfolder was carried over (the old whitelist bug dropped
 * roles/, specs/, phases/, ... — see convert.mjs).
 *
 *   Phase 1  convert.mjs        copy .claude → .pi-sync/  (full recursive copy)
 *   Phase 2  convert-pi.mjs     Claude patterns → pi  (in-place rewrite)
 *   Phase 3  convert-paths.mjs  legacy package paths → ~/.maestro paths
 *
 * Usage:
 *   node sync-pi.mjs                 # sync .pi-sync/ and verify
 *   node sync-pi.mjs --also-pi       # additionally deploy the converted
 *                                    # skills to resources/skills and agents to .pi/agents
 *   node sync-pi.mjs --skip-verify   # skip the parity check
 *
 * Environment overrides (mainly for verification / phase 2):
 *   PI_SYNC_SRC   source Claude dir   (default D:/maestro2/.claude)
 *   PI_SYNC_DST   pi build output dir (default <repo>/.pi-sync)
 *
 * Exit code: 0 on success, 1 if any phase fails or verification finds a
 * mismatch.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { deployConvertedPiMirror, deployPackagedAgents, removeRetiredPackageAgentsFile } from './deploy-pi-mirror.mjs';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

const SRC = resolve(process.env.PI_SYNC_SRC || 'D:/maestro2/.claude');
const DST = resolve(process.env.PI_SYNC_DST || join(repoRoot, '.pi-sync'));

const argv = process.argv.slice(2);
const ALSO_PI = argv.includes('--also-pi');
const SKIP_VERIFY = argv.includes('--skip-verify');
const MANAGED_MANIFEST_PATH = join(repoRoot, '.pi-mirror-managed.json');
const previousManaged = (() => {
  if (!existsSync(MANAGED_MANIFEST_PATH)) return {};
  try { return JSON.parse(readFileSync(MANAGED_MANIFEST_PATH, 'utf8')); }
  catch { return {}; }
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(msg) { process.stdout.write(msg + '\n'); }

function runPhase(label, script, extraEnv = {}) {
  log(`\n══════ ${label}: ${script} ══════`);
  const res = spawnSync(process.execPath, [join(repoRoot, script)], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  if (res.error) {
    log(`✗ ${label} failed to start: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    log(`✗ ${label} exited with code ${res.status}`);
    process.exit(1);
  }
  log(`✓ ${label} done`);
}

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) n += countFiles(full);
    else n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

log('pi-graph sync');
log(`  source: ${SRC}`);
log(`  target: ${DST}`);

if (!existsSync(SRC)) {
  log(`✗ source not found: ${SRC}`);
  process.exit(1);
}

// Phases 2 and 3 honour the destination override. Phase 1 still writes .pi-sync/.
runPhase('Phase 1 (copy .claude → flow)', 'convert.mjs');
runPhase('Phase 2 (Claude → pi rewrite)', 'convert-pi.mjs', {
  PI_MAESTRO_CONVERT_DST: DST,
});
runPhase('Phase 3 (normalize Maestro paths)', 'convert-paths.mjs');

// Package instructions live in the canonical .pi/SYSTEM.md. Remove the
// retired root AGENTS.md if an older sync left one behind.
const packageRoot = join(repoRoot, 'packages', 'pi-graph');
const retiredInstructions = removeRetiredPackageAgentsFile(packageRoot);
log(retiredInstructions.removed
  ? `  ✓ removed retired ${retiredInstructions.target}`
  : '  ✓ package instructions use .pi/SYSTEM.md (no retired AGENTS.md)');

// ---------------------------------------------------------------------------
// Optional skills (选装) — mirror <src>/optional/skills → <repo>/optional/skills
// ---------------------------------------------------------------------------

log('\n══════ Sync optional skills (选装) ══════');
const srcOptional = join(SRC, '..', 'optional', 'skills');
const dstOptional = join(repoRoot, 'optional', 'skills');
if (existsSync(srcOptional)) {
  if (existsSync(dstOptional)) rmSync(dstOptional, { recursive: true, force: true });
  cpSync(srcOptional, dstOptional, { recursive: true });
  log(`  ✓ optional/skills ← ${srcOptional} (${countFiles(dstOptional)} files)`);
} else {
  log('  - source optional/skills not found, skipped');
}

// ---------------------------------------------------------------------------
// Verification — every skill subfolder must be fully ported
// ---------------------------------------------------------------------------

if (!SKIP_VERIFY) {
  log('\n══════ Verify: skill subfolder parity ══════');
  const srcSkills = join(SRC, 'skills');
  const dstSkills = join(DST, 'skills');
  let mismatches = 0;
  let checked = 0;

  if (existsSync(srcSkills)) {
    for (const name of readdirSync(srcSkills)) {
      const sDir = join(srcSkills, name);
      if (!statSync(sDir).isDirectory()) continue;
      checked++;
      const sCount = countFiles(sDir);
      const dCount = countFiles(join(dstSkills, name));
      if (sCount !== dCount) {
        log(`  ✗ ${name}: source=${sCount} target=${dCount}`);
        mismatches++;
      }
    }
  }

  if (mismatches > 0) {
    log(`\n✗ ${mismatches}/${checked} skills lost files during conversion.`);
    process.exit(1);
  }
  log(`✓ ${checked} skills — full parity, no subfolder/file lost.`);
}

// ---------------------------------------------------------------------------
// Optional: deploy converted skills and agents to their canonical sources.
// ---------------------------------------------------------------------------

if (ALSO_PI) {
  log('\n══════ Deploy converted mirror to resources/skills and .pi/agents ══════');
  const managed = deployConvertedPiMirror(repoRoot, DST, previousManaged);
  // Package mirror: the published pi-graph npm package ships its role
  // catalog at <pkgRoot>/.pi/agents. The teammate package resolver finds that
  // sibling in global npm installs and uses the workspace-root canonical .pi
  // as a dev/npm-link fallback, so roles remain discoverable from ANY cwd.
  const pkgAgentsDir = join(repoRoot, 'packages', 'pi-graph', '.pi', 'agents');
  const canonicalAgentsDir = join(repoRoot, '.pi', 'agents');
  if (existsSync(canonicalAgentsDir)) {
    const packaged = deployPackagedAgents(canonicalAgentsDir, pkgAgentsDir);
    log(`  ✓ packages/pi-graph/.pi/agents ← .pi/agents (${packaged.deployed} role files)`);
  }
  writeFileSync(MANAGED_MANIFEST_PATH, `${JSON.stringify(managed, null, 2)}\n`);
}

log('\n✓ sync-pi complete.');
