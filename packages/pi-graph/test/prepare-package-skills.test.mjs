import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import crossSpawn from "cross-spawn";
import {
  cleanPackagedOptionalSkills,
  preparePackagedOptionalSkills,
} from "../scripts/prepare-package-skills.mjs";

test("package preparation copies optional skills into the package root", () => {
  const root = join(tmpdir(), `pi-maestro-pack-optional-${process.pid}-${Date.now()}`);
  const sourceDir = join(root, "source", "optional");
  const targetDir = join(root, "package", "optional");
  const skillPath = join(sourceDir, "skills", "scholar-writing", "SKILL.md");
  mkdirSync(join(sourceDir, "skills", "scholar-writing"), { recursive: true });
  writeFileSync(skillPath, "# Optional skill\n", "utf8");

  try {
    preparePackagedOptionalSkills({ sourceDir, targetDir });
    assert.equal(
      readFileSync(join(targetDir, "skills", "scholar-writing", "SKILL.md"), "utf8"),
      "# Optional skill\n",
    );
    cleanPackagedOptionalSkills({ targetDir });
    assert.equal(existsSync(targetDir), false);
  } finally {
    cleanPackagedOptionalSkills({ targetDir });
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepack stages only distributed skills; publish whitelist and cleanup preserve the worktree split", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-graph-pack-skills-"));
  const packageDir = join(root, "packages", "pi-graph");
  const script = join(packageDir, "scripts", "prepare-package-skills.mjs");
  const sources = {
    "resources/skills/team-swarm/SKILL.md": "# Team Swarm\n",
    "resources/skills/team-swarm/scripts/aco.py": "# Swarm script\n",
    "optional/skills/scholar-writing/SKILL.md": "# Optional skill\n",
    ".pi/skills/local-only/SKILL.md": "# User-owned work\n",
    ".pi/instructions/knowledge.md": "# Knowledge\n",
    ".pi/settings.local.json": "{}\n",
    ".pi/model-failover.json": "{}\n",
    ".pi/scratch/debug.log": "log\n",
    "packages/pi-graph/src/unrelated.ts": "// Unsaved work\n",
  };
  try {
    for (const [relativePath, content] of Object.entries(sources)) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    mkdirSync(join(packageDir, "scripts"), { recursive: true });
    copyFileSync(new URL("../scripts/prepare-package-skills.mjs", import.meta.url), script);
    copyFileSync(new URL("../package.json", import.meta.url), join(packageDir, "package.json"));

    execFileSync(process.execPath, [script], { cwd: packageDir });
    const included = [
      "skills/team-swarm/SKILL.md",
      "skills/team-swarm/scripts/aco.py",
      ".pi/instructions/knowledge.md",
      "optional/skills/scholar-writing/SKILL.md",
    ];
    for (const path of included) assert.ok(existsSync(join(packageDir, path)), path);
    for (const path of [".pi/skills", ".pi/settings.local.json", ".pi/model-failover.json", ".pi/scratch"]) {
      assert.equal(existsSync(join(packageDir, path)), false, path);
    }
    assert.equal(existsSync(join(packageDir, "skills", "local-only")), false);

    // Even stale nested .pi/skills in the package cannot bypass the whitelist.
    mkdirSync(join(packageDir, ".pi", "skills", "local-only"), { recursive: true });
    writeFileSync(join(packageDir, ".pi", "skills", "local-only", "SKILL.md"), "# Stale package mirror\n");
    const npmArgs = ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json", "--cache", join(root, "npm-cache")];
    const npmCli = process.env.npm_execpath;
    const dryRun = crossSpawn.sync(npmCli ? process.execPath : "npm", npmCli ? [npmCli, ...npmArgs] : npmArgs, {
      cwd: packageDir, encoding: "utf8", timeout: 15_000,
    });
    assert.ifError(dryRun.error);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const [packed] = JSON.parse(dryRun.stdout);
    const published = packed.files.map(({ path }) => path);
    for (const path of included) assert.ok(published.includes(path), path);
    assert.ok(published.every((path) => !path.startsWith(".pi/skills/") && !path.includes("local-only")));

    for (let i = 0; i < 2; i++) execFileSync(process.execPath, [script, "--clean"], { cwd: packageDir });
    assert.equal(existsSync(join(packageDir, "skills")), false);
    assert.equal(existsSync(join(packageDir, ".pi")), false);
    for (const [path, content] of Object.entries(sources)) assert.equal(readFileSync(join(root, path), "utf8"), content, path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
