import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import ts from "typescript";
import {
  preparePackagedOptionalSkills,
  preparePackagedPiResources,
  preparePackagedSkills,
} from "../scripts/prepare-package-skills.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const teammateRoot = join(root, "..", "pi-graph-agent-runtime");
const cockpitRoot = join(root, "..", "pi-graph-dashboard");
const settingsCoreRoot = join(root, "..", "pi-graph-shared-settings");
const executorsRoot = join(root, "..", "pi-graph-executors");
const exactSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const piCorePeerBaselines = {
  "@earendil-works/pi-agent-core": "1.6.0",
  "@earendil-works/pi-ai": "1.6.0",
  "@earendil-works/pi-coding-agent": "1.6.0",
  "@earendil-works/pi-tui": "1.6.0",
  typebox: "1.3.27",
};
const smartSearchSource = "https://github.com/konbakuyomu/smartsearch/archive/667c465d0f6ea16a423f03c434f94e21505d3595.tar.gz";
const teammatePublicExports = {
  ".": ["./types/index.d.ts", "./src/index.ts"],
  "./v1": ["./types/public/v1/index.d.ts", "./src/public/v1/index.ts"],
  "./v1/agents": ["./types/public/v1/agents.d.ts", "./src/public/v1/agents.ts"],
  "./v1/child-extensions": ["./types/public/v1/child-extensions.d.ts", "./src/public/v1/child-extensions.ts"],
  "./v1/events": ["./types/public/v1/events.d.ts", "./src/public/v1/events.ts"],
  "./v1/execution": ["./types/public/v1/execution.d.ts", "./src/public/v1/execution.ts"],
  "./v1/extension": ["./types/public/v1/extension.d.ts", "./src/public/v1/extension.ts"],
  "./v1/model-routing": ["./types/public/v1/model-routing.d.ts", "./src/public/v1/model-routing.ts"],
  "./v1/progress-tree": ["./types/public/v1/progress-tree.d.ts", "./src/public/v1/progress-tree.ts"],
  "./v1/retry": ["./types/public/v1/retry.d.ts", "./src/public/v1/retry.ts"],
  "./v1/types": ["./types/public/v1/types.d.ts", "./src/public/v1/types.ts"],
};

let stagedRoot;
before(() => {
  stagedRoot = mkdtempSync(join(tmpdir(), "pi-graph-package-resources-"));
  copyFileSync(join(root, "package.json"), join(stagedRoot, "package.json"));
  preparePackagedPiResources({ targetDir: join(stagedRoot, ".pi") });
  preparePackagedSkills({ targetDir: join(stagedRoot, "skills") });
  preparePackagedOptionalSkills({ targetDir: join(stagedRoot, "optional", "skills") });
});
after(() => {
  if (stagedRoot) rmSync(stagedRoot, { recursive: true, force: true });
});

test("package manifest publishes the extension and canonical Pi skills", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const teammatePkg = JSON.parse(readFileSync(join(teammateRoot, "package.json"), "utf8"));
  const cockpitPkg = JSON.parse(readFileSync(join(cockpitRoot, "package.json"), "utf8"));
  const settingsCorePkg = JSON.parse(readFileSync(join(settingsCoreRoot, "package.json"), "utf8"));
  assert.match(pkg.version, exactSemver);
  assert.equal(pkg.files.includes(".pi/"), true);
  assert.equal(pkg.files.includes("workflows/"), false);
  assert.equal(pkg.files.includes("AGENTS.md"), false, "bundled AGENTS.md injection is retired — .pi/SYSTEM.md (project-level) is the single authority");
  assert.equal(existsSync(join(root, "AGENTS.md")), false, "AGENTS.md must not be published; pi instructions live in the project .pi/SYSTEM.md");
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
  assert.ok(pkg.files.includes("skills/"));
  assert.ok(pkg.files.includes("!.pi/skills/**"));
  assert.match(pkg.scripts.postinstall, /install-workflows\.mjs/);
  assert.ok(pkg.files.includes("!.pi/**/__pycache__/**"));
  assert.ok(pkg.files.includes("!.pi/**/*.pyc"));
  assert.ok(pkg.files.includes("!.pi/settings.local.json"));
  assert.ok(pkg.files.includes("!.pi/model-failover.json"));
  assert.ok(pkg.files.includes("!.pi/scratch/**"));
  assert.equal(pkg.dependencies["maestro-flow"], ">=0.5.91");
  assert.equal(pkg.dependencies["pi-graph-shared-settings"], settingsCorePkg.version);
  assert.equal(teammatePkg.dependencies["pi-graph-shared-settings"], settingsCorePkg.version);
  assert.equal(cockpitPkg.dependencies["pi-graph-shared-settings"], settingsCorePkg.version);
  assert.equal(pkg.dependencies["pi-graph-agent-runtime"], teammatePkg.version);
  assert.equal(pkg.dependencies["pi-graph-dashboard"], cockpitPkg.version);
  const workspacePkg = JSON.parse(readFileSync(join(root, "..", "..", "package.json"), "utf8"));
  const executorsPkg = JSON.parse(readFileSync(join(executorsRoot, "package.json"), "utf8"));
  assert.equal(workspacePkg.dependencies["pi-graph"], pkg.version);
  assert.equal(workspacePkg.dependencies["pi-graph-agent-runtime"], teammatePkg.version);
  assert.equal(cockpitPkg.devDependencies["pi-graph-agent-runtime"], teammatePkg.version);
  assert.equal(pkg.dependencies["pi-graph-executors"], executorsPkg.version);
  assert.equal(teammatePkg.dependencies["pi-graph-executors"], executorsPkg.version);
  assert.equal(executorsPkg.dependencies.typebox, "1.3.27");
  assert.equal(pkg.dependencies["@konbakuyomu/smart-search"], undefined);
  assert.equal(pkg.optionalDependencies["@konbakuyomu/smart-search"], smartSearchSource);
  assert.equal(pkg.dependencies["puppeteer-core"], "25.12.0");
  assert.equal(pkg.dependencies["@modelcontextprotocol/sdk"], "1.32.1");
  assert.equal(pkg.optionalDependencies["pi-graph-window-info"], "9.0.1");
  assert.equal(pkg.optionalDependencies["pi-graph-desktop-automation"], "4.2.7");
  assert.equal(pkg.optionalDependencies["onnxruntime-node"], "1.30.0");
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.devDependencies.typescript, "5.7.3");
  assert.equal(pkg.engines.node, ">=22.19.0");
  assert.equal(pkg.files.includes("tsconfig.intelligence.json"), true);
  assert.equal(
    existsSync(join(root, "schemas", "swarm-run.schema.json")),
    false,
    "native swarm runtime schema must not be packaged",
  );
  assert.equal(pkg.peerDependencies?.["pi-graph-agent-runtime"], undefined);
  assert.equal(pkg.peerDependenciesMeta?.["pi-graph-agent-runtime"], undefined);
  assert.doesNotMatch(JSON.stringify(pkg), /file:D:|D:\\\\maestro2|link:/i);
});

test("the teammate dependency resolves to the workspace, not a nested copy", () => {
  // pi-graph-agent-runtime ships raw .ts (main is ./src/index.ts, there is no build step),
  // so it is only loadable because the workspace link resolves to a realpath *outside*
  // node_modules — node refuses to strip types for anything under node_modules.
  //
  // A nested real directory here shadows that link and takes every suite that reaches
  // teammate code down with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. It appears when
  // the declared range stops matching the workspace version, and npm installs a registry
  // copy; re-aligning the versions afterwards does not remove the copy it left behind.
  // The manifest check above prevents the drift — this one catches the leftover.
  const nested = join(root, "node_modules", "pi-graph-agent-runtime");
  assert.equal(
    existsSync(nested),
    false,
    `${nested} shadows the workspace link; remove it (or re-run npm install from the repo root)`,
  );

  const linked = join(root, "..", "..", "node_modules", "pi-graph-agent-runtime");
  assert.equal(existsSync(linked), true, "the workspace link is missing; run npm install from the repo root");
  assert.equal(
    realpathSync(linked),
    realpathSync(teammateRoot),
    "the hoisted teammate entry must resolve to packages/pi-graph-agent-runtime",
  );
});

test("teammate package publishes a versioned API with a real root entry", () => {
  const pkg = JSON.parse(readFileSync(join(teammateRoot, "package.json"), "utf8"));
  assert.match(pkg.version, exactSemver);
  assert.equal(pkg.main, "./src/index.ts");
  assert.equal(pkg.types, "./types/index.d.ts");
  assert.equal(pkg.files.includes("types/**/*.d.ts"), true);
  assert.equal(pkg.dependencies["cross-spawn"], "7.0.6");
  assert.equal(pkg.exports["./src/*"], "./src/*");
  assert.match(pkg.deprecatedSubpaths["./src/*"], /Compatibility only/);

  for (const [subpath, [types, defaultTarget]] of Object.entries(teammatePublicExports)) {
    assert.deepEqual(pkg.exports[subpath], { types, default: defaultTarget });
    for (const target of [types, defaultTarget]) {
      assert.equal(
        existsSync(join(teammateRoot, target)),
        true,
        `${subpath} must target a packaged file: ${target}`,
      );
    }
  }
});

test("Pi extension manifests keep host core packages as optional wildcard peers", () => {
  for (const packageRoot of [root, teammateRoot, cockpitRoot]) {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    for (const [packageName, devBaseline] of Object.entries(piCorePeerBaselines)) {
      assert.equal(pkg.dependencies?.[packageName], undefined, `${pkg.name} must not own ${packageName} at runtime`);
      assert.equal(pkg.peerDependencies?.[packageName], "*", `${pkg.name} must accept the host ${packageName}`);
      assert.equal(
        pkg.peerDependenciesMeta?.[packageName]?.optional,
        true,
        `${pkg.name} must make the ${packageName} peer optional`,
      );
      assert.equal(pkg.devDependencies?.[packageName], devBaseline, `${pkg.name} must develop against ${packageName}@${devBaseline}`);
    }
  }
});

test("Flow production imports use the versioned teammate API", () => {
  const privateImports = collectTypeScriptFiles(join(root, "src"))
    .flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return collectModuleSpecifiers(source)
        .some((specifier) => specifier.startsWith("pi-graph-agent-runtime/src/"))
        ? [filePath]
        : [];
    });
  assert.deepEqual(privateImports, []);
});

test("production import scan ignores comments and detects private teammate imports", () => {
  const commentOnly = `
    /**
     * See pi-graph-agent-runtime/src/shared/types.ts for the runtime contract.
     */
    export const publicSpecifier = "pi-graph-agent-runtime/v1/types";
  `;
  assert.deepEqual(collectModuleSpecifiers(commentOnly), []);

  const privateSpecifier = "pi-graph-agent-runtime/src/shared/types.ts";
  const realImports = `
    import "${privateSpecifier}";
    export { value } from "${privateSpecifier}";
    void import("${privateSpecifier}");
  `;
  assert.deepEqual(collectModuleSpecifiers(realImports), [
    privateSpecifier,
    privateSpecifier,
    privateSpecifier,
  ]);
});

test("package contains the canonical workflow skill set", () => {
  const skillPath = join(stagedRoot, "skills", "workflow-skill-designer", "SKILL.md");
  assert.match(readFileSync(skillPath, "utf8"), /workflow skills/i);
  const swarmSkillPath = join(stagedRoot, "skills", "team-swarm", "SKILL.md");
  assert.equal(
    existsSync(swarmSkillPath),
    true,
    "team-swarm must be packaged as the sole swarm execution owner",
  );
  const swarmSkill = readFileSync(swarmSkillPath, "utf8");
  assert.match(
    swarmSkill,
    /Hybrid coordinator/,
    "team-swarm must retain the Python ACO execution contract",
  );
  assert.equal(existsSync(join(stagedRoot, "skills", "swarm", "SKILL.md")), false, "native swarm Skill must not be packaged");
  assert.ok(existsSync(join(stagedRoot, "skills", "team-swarm", "scripts", "aco.py")));
});

test("Pi discovers bundled skills via package registration, not checkout-local discovery", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-graph-skill-discovery-"));
  try {
    const cwd = join(sandbox, "project");
    const agentDir = join(sandbox, "agent");
    const localSkill = join(cwd, ".pi", "skills", "local-demo", "SKILL.md");
    const localSourceSkill = join(cwd, "resources", "skills", "source-demo", "SKILL.md");
    for (const [path, name] of [[localSkill, "local-demo"], [localSourceSkill, "source-demo"]]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `---\nname: ${name}\ndescription: Discovery fixture\n---\n`);
    }
    mkdirSync(agentDir);
    copyFileSync(join(root, "..", "..", ".pi", "settings.json"), join(cwd, ".pi", "settings.json"));
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { realpathSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
      const [cwd, agentDir, packageRoot, localSkill] = process.argv.slice(1);
      const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true });
      const skills = () => new Map(loader.getSkills().skills.map(skill => [skill.name, skill.filePath]));
      await loader.reload();
      assert.equal(realpathSync(skills().get("local-demo")), realpathSync(localSkill));
      assert.equal(skills().has("source-demo"), false);
      assert.equal(skills().has("workflow-skill-designer"), false);
      writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot] }));
      await loader.reload();
      assert.equal(realpathSync(skills().get("workflow-skill-designer")), realpathSync(join(packageRoot, "skills", "workflow-skill-designer", "SKILL.md")));
      assert.equal(skills().has("source-demo"), false);
    `, cwd, agentDir, stagedRoot, localSkill], {
      cwd, env: { ...process.env, HOME: sandbox, USERPROFILE: sandbox, PI_CODING_AGENT_DIR: agentDir },
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("knowledge capture skills remain user-invoked and the system prompt introduces Know-how", () => {
  const knowhowSkill = readFileSync(join(stagedRoot, "skills", "maestro-knowhow", "SKILL.md"), "utf8");
  const specSkill = readFileSync(join(stagedRoot, "skills", "maestro-spec", "SKILL.md"), "utf8");
  const systemPrompt = readFileSync(join(stagedRoot, ".pi", "SYSTEM.md"), "utf8");

  assert.match(knowhowSkill, /disable-model-invocation:\s*true/);
  assert.match(specSkill, /disable-model-invocation:\s*true/);
  assert.match(systemPrompt, /`maestro-knowhow` captures reusable knowledge in `\.workflow\/knowhow\/`/);
  assert.match(systemPrompt, /Automatically load and follow it/);
  assert.match(systemPrompt, /use `maestro-spec` instead for explicit project constraints/);
  assert.doesNotMatch(systemPrompt, /docs\/knowhow\//);
});

test("package publishes optional skills from the repository root", () => {
  assert.equal(
    existsSync(join(stagedRoot, "optional", "skills", "scholar-writing", "SKILL.md")),
    true,
    "prepack must materialize optional skills inside the npm package root",
  );
});

test("package publishes the full canonical Pi directory except local-only files", () => {
  for (const entry of ["SYSTEM.md", "agents", "settings.json", "teammate-models.json", "instructions/knowledge.md"]) {
    assert.equal(existsSync(join(stagedRoot, ".pi", entry)), true, `.pi/${entry} must be packaged`);
  }
  assert.equal(existsSync(join(stagedRoot, ".pi", "hooks.json")), false, "the current canonical Pi resources must not stage a .pi/hooks.json placeholder");
  for (const entry of ["settings.local.json", "model-failover.json", "scratch", "skills"]) {
    assert.equal(existsSync(join(stagedRoot, ".pi", entry)), false, `.pi/${entry} is local-only and must not be packaged`);
  }
  // The packaged role catalog ships role definitions and their schema, but
  // never the runtime capture records (<correlationId>.json).
  const packagedAgents = readdirSync(join(stagedRoot, ".pi", "agents"));
  assert.equal(packagedAgents.includes("general-executor.md"), true, "role definitions must be packaged");
  assert.equal(packagedAgents.includes("general-executor-report.schema.json"), true, "role schema must be packaged");
  assert.equal(packagedAgents.some((name) => /^[0-9a-f-]+\.json$/.test(name)), false, "capture records must not be packaged");
});

function collectTypeScriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) return collectTypeScriptFiles(filePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
  });
}

function collectModuleSpecifiers(source) {
  return ts.preProcessFile(source, true, true).importedFiles
    .map((reference) => reference.fileName);
}
