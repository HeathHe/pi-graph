import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  collectCompanionDirs,
  getAgentDir,
  getCompanionStatePath,
  registerCompanionPackages,
  resolvePackageDir,
} from "../scripts/register-companion-packages.mjs";

const flowRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const flowPackage = JSON.parse(readFileSync(join(flowRoot, "package.json"), "utf8"));
const COMPANION_VERSIONS = {
  "pi-graph-agent-runtime": flowPackage.dependencies["pi-graph-agent-runtime"],
  "pi-graph-dashboard": flowPackage.dependencies["pi-graph-dashboard"],
};

function writePackage(directory, name, version = COMPANION_VERSIONS[name] ?? "1.0.0") {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }), "utf8");
}

function writeJson(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-register-companion-"));
  const agentDir = join(root, ".pi", "agent");
  const settingsFile = join(agentDir, "settings.json");
  const stateFile = getCompanionStatePath(agentDir);
  const teammate = join(root, "current", "pi-graph-agent-runtime");
  const cockpit = join(root, "current", "pi-graph-dashboard");
  writePackage(teammate, "pi-graph-agent-runtime");
  writePackage(cockpit, "pi-graph-dashboard");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    agentDir,
    settingsFile,
    stateFile,
    teammate,
    cockpit,
    packageDirs: [teammate, cockpit],
  };
}

function register(state, overrides = {}) {
  return registerCompanionPackages({
    settingsFile: state.settingsFile,
    stateFile: state.stateFile,
    packageDirs: state.packageDirs,
    expectedVersions: COMPANION_VERSIONS,
    ...overrides,
  });
}

function readState(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

test("adds companions and records their ownership on a fresh install", (t) => {
  const state = fixture(t);
  const result = register(state);

  assert.equal(result.changed, true);
  assert.deepEqual(result.added, state.packageDirs);
  assert.deepEqual(readState(state.settingsFile).packages, state.packageDirs);
  assert.deepEqual(
    Object.fromEntries(Object.entries(readState(state.stateFile).companions).map(([name, entry]) => [name, entry.source])),
    {
      "pi-graph-agent-runtime": state.teammate,
      "pi-graph-dashboard": state.cockpit,
    },
  );
});

test("is idempotent after postinstall and extension-load registration", (t) => {
  const state = fixture(t);
  register(state);
  const second = register(state);

  assert.equal(second.changed, false);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.replaced, []);
  assert.deepEqual(second.adopted, []);
});

test("preserves unrelated settings keys and package entries", (t) => {
  const state = fixture(t);
  const unrelated = { source: join(state.root, "plugins", "unrelated"), skills: ["-legacy"], custom: true };
  const opaque = { futurePackageFormat: true, resources: ["custom"] };
  writeJson(state.settingsFile, { theme: "ocean", model: "x", packages: [unrelated, opaque, null] });

  register(state);

  const written = readState(state.settingsFile);
  assert.equal(written.theme, "ocean");
  assert.equal(written.model, "x");
  assert.deepEqual(written.packages, [unrelated, opaque, null, ...state.packageDirs]);
});

test("replaces a sidecar-owned companion source while preserving object resource configuration", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-graph-agent-runtime");
  writePackage(old, "pi-graph-agent-runtime");
  const entry = { source: old, skills: ["-legacy"], extensions: ["./custom.ts"], custom: true };
  writeJson(state.settingsFile, { packages: [entry] });
  writeJson(state.stateFile, {
    version: 1,
    companions: { "pi-graph-agent-runtime": { source: old } },
  });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-graph-agent-runtime", from: old, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [{ ...entry, source: state.teammate }]);
  assert.equal(readState(state.stateFile).companions["pi-graph-agent-runtime"].source, state.teammate);
});

test("re-enables extensions for a Flow-managed companion registration", (t) => {
  const state = fixture(t);
  register(state, { packageDirs: [state.teammate] });
  const disabled = {
    source: state.teammate,
    extensions: [],
    skills: ["./custom-skill"],
    custom: true,
  };
  writeJson(state.settingsFile, { packages: [disabled] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, true);
  assert.deepEqual(readState(state.settingsFile).packages, [{
    source: state.teammate,
    skills: ["./custom-skill"],
    custom: true,
  }]);
  assert.equal(register(state, { packageDirs: [state.teammate] }).changed, false);
});

test("restores the plain package entry when an empty extension filter is the only override", (t) => {
  const state = fixture(t);
  register(state, { packageDirs: [state.teammate] });
  writeJson(state.settingsFile, {
    packages: [{ source: state.teammate, extensions: [] }],
  });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, true);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
  assert.equal(register(state, { packageDirs: [state.teammate] }).changed, false);
});

test("migrates a legacy companion nested under an older Flow package root", (t) => {
  const state = fixture(t);
  const oldFlow = join(state.root, "old-flow");
  const old = join(oldFlow, "node_modules", "pi-graph-teammate");
  writePackage(oldFlow, "pi-graph", "0.14.1");
  writePackage(old, "pi-graph-teammate");
  writeJson(state.settingsFile, { packages: [old] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-graph-agent-runtime", from: old, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
  assert.equal(readState(state.stateFile).companions["pi-graph-agent-runtime"].source, state.teammate);
});

test("migrates a symlinked legacy companion using its logical Flow ancestry", (t) => {
  const state = fixture(t);
  const oldFlow = join(state.root, "old-flow");
  const stored = join(state.root, "package-store", "pi-graph-teammate");
  const linked = join(oldFlow, "node_modules", "pi-graph-teammate");
  writePackage(oldFlow, "pi-graph", "0.14.1");
  writePackage(stored, "pi-graph-teammate");
  mkdirSync(dirname(linked), { recursive: true });
  try {
    symlinkSync(stored, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    t.skip(`symlink unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  writeJson(state.settingsFile, { packages: [linked] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.deepEqual(result.replaced, [{ name: "pi-graph-agent-runtime", from: linked, to: state.teammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [state.teammate]);
});

test("preserves a local checkout nested under a Flow repository root", (t) => {
  const state = fixture(t);
  const checkout = join(state.root, "checkout", "pi-graph");
  const localTeammate = join(checkout, "packages", "pi-graph-agent-runtime");
  writePackage(checkout, "pi-graph", "0.14.1");
  writePackage(localTeammate, "pi-graph-agent-runtime");
  writeJson(state.settingsFile, { packages: [localTeammate] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.preservedUnowned, [{ name: "pi-graph-agent-runtime", source: localTeammate }]);
  assert.deepEqual(readState(state.settingsFile).packages, [localTeammate]);
});

test("preserves an unowned legacy name and does not confuse a similarly named package with it", (t) => {
  const state = fixture(t);
  const override = join(state.root, "checkout", "pi-graph-teammate");
  const other = join(state.root, "old-flow", "node_modules", "pi-graph-cockpit-tools");
  writePackage(override, "pi-graph-teammate");
  writePackage(join(state.root, "old-flow"), "pi-graph");
  writePackage(other, "pi-graph-cockpit-tools");
  writeJson(state.settingsFile, { packages: [override, other] });

  const result = register(state);

  assert.deepEqual(result.preservedUnowned, [{ name: "pi-graph-agent-runtime", source: override }]);
  assert.deepEqual(result.added, [state.cockpit]);
  assert.deepEqual(readState(state.settingsFile).packages, [override, other, state.cockpit]);
});

test("preserves a disabled same-name workspace override without adding a duplicate companion", (t) => {
  const state = fixture(t);
  const workspace = join(state.root, "workspace", "pi-graph-agent-runtime");
  writePackage(workspace, "pi-graph-agent-runtime");
  const entry = { source: workspace, extensions: [], custom: true };
  writeJson(state.settingsFile, { packages: [entry] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, false);
  assert.deepEqual(result.preservedUnowned, [{ name: "pi-graph-agent-runtime", source: workspace }]);
  assert.deepEqual(readState(state.settingsFile).packages, [entry]);
  assert.equal(existsSync(state.stateFile), false);
});

test("dedupes managed aliases while preferring an object entry over a preceding string", (t) => {
  const state = fixture(t);
  const entry = { source: join(state.teammate, "."), skills: ["-legacy"], custom: true };
  writeJson(state.settingsFile, { packages: [state.teammate, entry] });

  const result = register(state, { packageDirs: [state.teammate] });

  assert.equal(result.changed, true);
  assert.deepEqual(readState(state.settingsFile).packages, [entry]);
  assert.equal(readState(state.stateFile).companions["pi-graph-agent-runtime"].source, state.teammate);
});

test("fails closed when managed aliases carry conflicting object configuration", (t) => {
  const state = fixture(t);
  const first = { source: state.teammate, skills: ["-first"] };
  const second = { source: join(state.teammate, "."), extensions: ["./second.ts"] };
  writeJson(state.settingsFile, { packages: [first, second] });
  const before = readFileSync(state.settingsFile, "utf8");

  assert.throws(
    () => register(state, { packageDirs: [state.teammate] }),
    /Cannot safely dedupe companion aliases with conflicting resource configuration/,
  );
  assert.equal(readFileSync(state.settingsFile, "utf8"), before);
  assert.equal(existsSync(state.stateFile), false);
});

test("replaces a missing sidecar-owned source but preserves an unreadable unowned source", (t) => {
  const state = fixture(t);
  const ownedMissing = join(state.root, "old", "pi-graph-agent-runtime");
  writeJson(state.settingsFile, { packages: [ownedMissing] });
  writeJson(state.stateFile, {
    version: 1,
    companions: { "pi-graph-agent-runtime": { source: ownedMissing } },
  });

  const replaced = register(state, { packageDirs: [state.teammate] });
  assert.deepEqual(replaced.replaced, [{ name: "pi-graph-agent-runtime", from: ownedMissing, to: state.teammate }]);

  const unownedMissing = join(state.root, "manual", "pi-graph-agent-runtime");
  writeJson(state.settingsFile, { packages: [unownedMissing] });
  rmSync(state.stateFile, { force: true });
  const preserved = register(state, { packageDirs: [state.teammate] });
  assert.deepEqual(preserved.added, [state.teammate]);
  assert.deepEqual(readState(state.settingsFile).packages, [unownedMissing, state.teammate]);
});

test("fails closed for malformed settings or companion state", (t) => {
  const state = fixture(t);
  writeJson(state.stateFile, { version: 1, companions: {} });
  writeFileSync(state.settingsFile, "not json", "utf8");
  const settingsBefore = readFileSync(state.settingsFile, "utf8");
  const stateBefore = readFileSync(state.stateFile, "utf8");

  assert.throws(() => register(state), /Cannot read Pi settings/);
  assert.equal(readFileSync(state.settingsFile, "utf8"), settingsBefore);
  assert.equal(readFileSync(state.stateFile, "utf8"), stateBefore);

  writeJson(state.settingsFile, []);
  assert.throws(() => register(state), /root value must be an object/);
  writeJson(state.settingsFile, { packages: [] });
  writeJson(state.stateFile, { version: 2, companions: {} });
  assert.throws(() => register(state), /Invalid Maestro companion state/);
});

test("keeps both files unchanged when the settings write fails", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-graph-agent-runtime");
  writePackage(old, "pi-graph-agent-runtime");
  writeJson(state.settingsFile, { packages: [old] });
  writeJson(state.stateFile, { version: 1, companions: { "pi-graph-agent-runtime": { source: old } } });
  const settingsBefore = readFileSync(state.settingsFile, "utf8");
  const stateBefore = readFileSync(state.stateFile, "utf8");

  assert.throws(() => register(state, {
    packageDirs: [state.teammate],
    writeFile(filePath, content) {
      if (filePath === state.settingsFile) throw new Error("injected settings write failure");
      writeFileSync(filePath, content, "utf8");
    },
  }), /injected settings write failure/);

  assert.equal(readFileSync(state.settingsFile, "utf8"), settingsBefore);
  assert.equal(readFileSync(state.stateFile, "utf8"), stateBefore);
});

test("recovers an old-name sidecar when writing it fails after settings are updated", (t) => {
  const state = fixture(t);
  const old = join(state.root, "old", "pi-graph-cockpit");
  // The old package can already be gone: its exact sidecar source establishes ownership.
  const entry = { source: old, skills: ["-legacy"], custom: true };
  writeJson(state.settingsFile, { packages: [entry] });
  writeJson(state.stateFile, { version: 1, companions: { "pi-graph-cockpit": { source: old } } });

  assert.throws(() => register(state, {
    packageDirs: [state.cockpit],
    writeFile(filePath, content) {
      if (filePath === state.stateFile) throw new Error("injected state write failure");
      writeFileSync(filePath, content, "utf8");
    },
  }), /injected state write failure/);
  assert.deepEqual(readState(state.settingsFile).packages, [{ ...entry, source: state.cockpit }]);
  assert.equal(readState(state.stateFile).companions["pi-graph-cockpit"].source, old);

  const recovered = register(state, { packageDirs: [state.cockpit] });
  assert.equal(recovered.changed, true);
  const companions = readState(state.stateFile).companions;
  assert.equal(companions["pi-graph-dashboard"].source, state.cockpit);
  assert.equal(companions["pi-graph-cockpit"], undefined);
  assert.equal(register(state, { packageDirs: [state.cockpit] }).changed, false);
});

test("uses the configured Pi agent directory for settings and companion state", (t) => {
  const state = fixture(t);
  assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: state.agentDir }), state.agentDir);

  const result = registerCompanionPackages({
    agentDir: state.agentDir,
    packageDirs: [state.teammate],
    expectedVersions: COMPANION_VERSIONS,
  });

  assert.equal(result.settingsFile, state.settingsFile);
  assert.equal(result.stateFile, state.stateFile);
  assert.equal(existsSync(state.settingsFile), true);
  assert.equal(existsSync(state.stateFile), true);
});

test("reports a resolved companion version that does not match Flow's exact dependency", (t) => {
  const state = fixture(t);
  const mismatched = join(state.root, "mismatched", "pi-graph-agent-runtime");
  writePackage(mismatched, "pi-graph-agent-runtime", "9.9.9");

  const result = register(state, { packageDirs: [mismatched] });

  assert.deepEqual(result.versionMismatch, [{
    name: "pi-graph-agent-runtime",
    expected: COMPANION_VERSIONS["pi-graph-agent-runtime"],
    actual: "9.9.9",
  }]);
});

test("resolvePackageDir locates the workspace teammate package", () => {
  const dir = resolvePackageDir("pi-graph-agent-runtime", import.meta.url);
  assert.ok(dir, "expected to resolve pi-graph-agent-runtime");
  assert.equal(readState(join(dir, "package.json")).name, "pi-graph-agent-runtime");
});

test("resolvePackageDir returns undefined for a missing package", () => {
  assert.equal(resolvePackageDir("pi-maestro-does-not-exist", import.meta.url), undefined);
});

test("collectCompanionDirs resolves the real companions from this workspace", () => {
  const dirs = collectCompanionDirs({ fromUrl: import.meta.url });
  assert.ok(dirs.length >= 1, "expected at least one companion to resolve");
  for (const dir of dirs) {
    assert.equal(existsSync(join(dir, "package.json")), true);
  }
});
