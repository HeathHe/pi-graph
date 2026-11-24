import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Packed consumers cannot fall back to npm for the as-yet-unpublished Graph
// dependencies. Pack the required first-party closure but not optional native
// providers, which these tests exercise separately (if at all).
export function packGraphDependencies({ packagesDir, alreadyPacked, pack }) {
  const packed = new Set(alreadyPacked);
  const visited = new Set();
  const dependencies = [];
  function visit(name) {
    if (visited.has(name)) return;
    visited.add(name);
    const dir = join(packagesDir, name);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (dependency === "pi-graph" || dependency.startsWith("pi-graph-")) visit(dependency);
    }
    if (!packed.has(name)) dependencies.push([name, pack(dir)]);
  }
  for (const name of alreadyPacked) visit(name);
  return dependencies;
}
