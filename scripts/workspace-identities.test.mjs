import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join, sep } from "node:path";
import test from "node:test";

const repo = fileURLToPath(new URL("../", import.meta.url));
const readJson = (...path) => JSON.parse(readFileSync(join(repo, ...path), "utf8"));
const names = [
  "pi-graph", "pi-graph-agent-runtime", "pi-graph-dashboard", "pi-graph-desktop-automation",
  "pi-graph-desktop-provider-api", "pi-graph-desktop-shared", "pi-graph-device-api", "pi-graph-device-network",
  "pi-graph-execution-api", "pi-graph-executors", "pi-graph-shared-settings", "pi-graph-terminal-ui",
  "pi-graph-window-info",
];

test("Graph checkout manifests and lock records agree", () => {
  const root = readJson("package.json");
  const lock = readJson("package-lock.json");
  assert.deepEqual(root.workspaces, ["packages/*"]);
  assert.equal(root.name, "pi-graph-workspace");
  assert.equal(lock.name, root.name);
  assert.equal(lock.packages[""].name, root.name);
  const dirs = readdirSync(join(repo, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(repo, "packages", entry.name, "package.json")))
    .map((entry) => entry.name).sort();
  assert.deepEqual(dirs, names);
  const lockedLinks = Object.entries(lock.packages).filter(([, record]) => record.link);
  assert.deepEqual(lockedLinks.map(([location]) => location).sort(), names.map((name) => `node_modules/${name}`));
  const manifests = new Map(names.map((name) => [name, readJson("packages", name, "package.json")]));
  const dependencyFields = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "peerDependenciesMeta", "bin"];
  for (const [name, manifest] of manifests) {
    const dir = `packages/${name}`;
    assert.equal(manifest.name, name);
    const location = `node_modules/${name}`;
    assert.deepEqual(lock.packages[location], { resolved: dir, link: true });
    assert.equal(lock.packages[dir].version, manifest.version);
    for (const field of dependencyFields) {
      const expected = field === "bin" && manifest.bin
        ? Object.fromEntries(Object.entries(manifest.bin).map(([command, file]) => [command, file.replace(/^\.\//u, "")]))
        : manifest[field];
      assert.deepEqual(lock.packages[dir][field], expected, `${name}: ${field}`);
    }
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(manifest[field] ?? {})) {
        if (manifests.has(dep)) assert.equal(range, manifests.get(dep).version, `${name}: ${dep} must pin the workspace version`);
      }
    }
    for (const entry of [...Object.values(manifest.bin ?? {}), ...(manifest.pi?.extensions ?? [])]) {
      assert.ok(existsSync(join(repo, dir, entry)), `${name}: missing ${entry}`);
    }
  }
});

test("npm links each Graph identity to its matching checkout workspace", () => {
  for (const name of names) {
    assert.equal(realpathSync(join(repo, "node_modules", name)), realpathSync(join(repo, "packages", name)));
  }
  const fromFlow = createRequire(join(repo, "packages/pi-graph/package.json"));
  for (const specifier of ["pi-graph/gateway/v1", "pi-graph-agent-runtime/v1/execution", "pi-graph-shared-settings", "pi-graph-window-info", "pi-graph-desktop-automation"]) {
    const resolved = fromFlow.resolve(specifier);
    const packageName = specifier.split("/")[0];
    assert.ok(resolved.startsWith(`${realpathSync(join(repo, "packages", packageName))}${sep}`), resolved);
  }
});

test("Fluent TUI pins the same renamed platform IDs that its launcher resolves", () => {
  const dir = "packages/pi-graph-terminal-ui";
  const manifest = readJson(dir, "package.json");
  const platforms = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-x64"];
  assert.deepEqual(manifest.optionalDependencies, Object.fromEntries(platforms.map((target) => [`${manifest.name}-${target}`, manifest.version])));
  const wrapper = readFileSync(join(repo, dir, "bin/run.js"), "utf8");
  for (const platform of platforms) assert.ok(wrapper.includes(`"${platform}": "${manifest.name}-${platform}"`));
  assert.equal(wrapper.includes("@dyw1234/"), false);
});
