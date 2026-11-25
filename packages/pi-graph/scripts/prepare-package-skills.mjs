import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");

// Restore the tracked package optional/skills tree from HEAD. cpSync from the
// canonical source leaves a stale stat-cache "modified" state under
// core.autocrlf; `git checkout HEAD --` rewrites the index entries cleanly so
// the worktree matches the committed tree. Silent no-op when git is unavailable
// or the path is untracked (e.g. fresh clone before first prepare).
function restoreTrackedOptionalSkills() {
  const rel = "packages/pi-graph/optional/skills";
  const res = spawnSync("git", ["-C", repoRoot, "checkout", "HEAD", "--", rel], {
    stdio: "ignore",
  });
  if (res.status !== 0) {
    // Fall back to source re-sync so callers still get a populated tree.
    const sourceDir = resolve(repoRoot, "optional", "skills");
    const targetDir = join(packageRoot, "optional", "skills");
    if (existsSync(sourceDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(sourceDir, targetDir, { recursive: true });
    }
  }
}

// Gitignored local-only entries in the canonical .pi directory; never packaged.
const localOnlyEntries = new Set(["settings.local.json", "model-failover.json", "scratch"]);

// Runtime capture records under .pi/agents (<correlationId>.json) are
// gitignored but would still ship because the npm "files" whitelist for .pi/
// bypasses gitignore. Role definitions (*.md) and their schema (*.schema.json)
// must ship — the packaged role catalog is what the teammate extension
// discovers from any cwd.
function isPackagedAgentsEntry(relative) {
  if (!relative.startsWith("agents/")) return true;
  if (relative.endsWith(".md")) return true;
  if (relative.endsWith(".schema.json")) return true;
  return false;
}

const defaultPiTargetDir = join(packageRoot, ".pi");
const defaultSkillsTargetDir = join(packageRoot, "skills");

function prepareGeneratedTree(sourceDir, targetDir, include = () => true) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Canonical package resource directory not found: ${sourceDir}`);
  }
  const sourcePrefix = resolve(sourceDir).replaceAll("\\", "/");
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter(source) {
      const normalized = resolve(source).replaceAll("\\", "/");
      const relative = normalized === sourcePrefix ? "" : normalized.slice(sourcePrefix.length + 1);
      return !relative.split("/").includes("__pycache__") && !relative.endsWith(".pyc") && include(relative);
    },
  });
  return { sourceDir, targetDir };
}

export function preparePackagedPiResources({
  sourceDir = join(repoRoot, ".pi"),
  targetDir = defaultPiTargetDir,
} = {}) {
  return prepareGeneratedTree(sourceDir, targetDir, (relative) => {
    const entry = relative.split("/")[0];
    return entry !== "skills" && !localOnlyEntries.has(entry) && isPackagedAgentsEntry(relative);
  });
}

export function preparePackagedSkills({
  sourceDir = join(repoRoot, "resources", "skills"),
  targetDir = defaultSkillsTargetDir,
} = {}) {
  return prepareGeneratedTree(sourceDir, targetDir);
}

export function cleanPackagedPiResources({ targetDir = defaultPiTargetDir } = {}) {
  rmSync(targetDir, { recursive: true, force: true });
  return { targetDir };
}

export function cleanPackagedSkills({ targetDir = defaultSkillsTargetDir } = {}) {
  rmSync(targetDir, { recursive: true, force: true });
  return { targetDir };
}

// Canonical optional skills live at <repo>/optional/skills and are a tracked
// release asset mirrored into the package at <pkg>/optional/skills. Unlike the
// gitignored .pi/ mirror, this tree is versioned, so clean() restores it from
// HEAD instead of deleting it — otherwise the worktree diverges from the
// committed tree. Only an explicit non-default targetDir (test fixtures) is
// treated as disposable and removed.
const canonicalOptionalSourceDir = resolve(packageRoot, "..", "..", "optional", "skills");
const defaultOptionalTargetDir = join(packageRoot, "optional", "skills");

export function preparePackagedOptionalSkills({
  sourceDir = canonicalOptionalSourceDir,
  targetDir = defaultOptionalTargetDir,
} = {}) {
  if (!existsSync(sourceDir)) {
    throw new Error(`Canonical optional skills directory not found: ${sourceDir}`);
  }
  rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { sourceDir, targetDir };
}

export function cleanPackagedOptionalSkills({
  sourceDir = canonicalOptionalSourceDir,
  targetDir = defaultOptionalTargetDir,
} = {}) {
  if (resolve(targetDir) === resolve(defaultOptionalTargetDir)) {
    // Tracked release asset: restore from HEAD via git so the worktree stays
    // in sync (cpSync would leave a stale stat-cache "modified" state under
    // core.autocrlf). Deleting it would diverge from the committed tree.
    restoreTrackedOptionalSkills();
  } else {
    // Disposable fixture (tests): remove outright.
    rmSync(targetDir, { recursive: true, force: true });
  }
  return { targetDir };
}

function run() {
  if (process.argv.includes("--clean")) {
    cleanPackagedSkills();
    cleanPackagedPiResources();
    cleanPackagedOptionalSkills();
    return;
  }
  const piResult = preparePackagedPiResources();
  const skillsResult = preparePackagedSkills();
  const optionalResult = preparePackagedOptionalSkills();
  console.log(`[pi-graph] Prepared non-skill Pi resources from ${piResult.sourceDir}`);
  console.log(`[pi-graph] Prepared bundled skills from ${skillsResult.sourceDir}`);
  console.log(`[pi-graph] Prepared optional skills from ${optionalResult.sourceDir}`);
}

if (import.meta.main) run();
