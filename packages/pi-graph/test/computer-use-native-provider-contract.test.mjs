import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(packageRoot, "..", "..");
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync(join(packageRoot, "optional", "computer-use-manifest.json"), "utf8"));
const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"));

const expectedOptional = {
  "pi-graph-desktop-automation": "4.2.7",
  "pi-graph-window-info": "9.0.1",
  "node-window-manager": "2.2.4",
  "onnxruntime-node": "1.30.0",
  "screenshot-desktop": "1.15.6",
};
const graphProviderNames = {
  "@nut-tree-fork/nut-js": "pi-graph-desktop-automation",
  "active-win": "pi-graph-window-info",
};

function packageEntry(name) {
  const entry = lock.packages[`packages/pi-graph/node_modules/${name}`] ?? lock.packages[`node_modules/${name}`];
  if (!name.startsWith("pi-graph-")) return entry;
  assert.equal(entry?.link, true, `${name} must resolve to a workspace`);
  assert.equal(entry.resolved, `packages/${name}`);
  return lock.packages[entry.resolved];
}

test("current Graph optional provider versions and workspace links are locked together", () => {
  for (const [name, version] of Object.entries(expectedOptional)) {
    assert.equal(packageManifest.optionalDependencies[name], version, `${name} must be a direct optional dependency`);
    assert.equal(packageEntry(name)?.version, version, `${name} has the wrong version in package-lock`);
  }
  for (const name of Object.keys(graphProviderNames)) {
    assert.equal(packageManifest.optionalDependencies[name], undefined, `${name} must not be an alias`);
  }
  for (const name of ["pi-graph-desktop-shared", "pi-graph-desktop-provider-api"]) {
    assert.equal(packageEntry("pi-graph-desktop-automation").dependencies[name], "4.2.7");
    assert.equal(packageEntry(name)?.version, "4.2.7");
  }
});

test("historical CU-0 provenance retains its fail-closed model contract", () => {
  assert.equal(manifest.schema_version, "computer-use-manifest/0.1");
  assert.equal(manifest.fail_closed.diagnostic_code, "MODEL_PROVENANCE_UNVERIFIED");
  assert.equal(manifest.fail_closed.unverified_model_status, "unavailable");
  const iconDetect = manifest.model_artifacts.find((artifact) => artifact.id === "omniparser.v2.icon_detect");
  assert.ok(iconDetect.status === "verified_local" || iconDetect.status === "unverified_missing", "icon_detect status must be a known contract state");
  if (iconDetect.status === "verified_local") {
    assert.match(iconDetect.sha256, /^[a-f0-9]{64}$/, "verified icon_detect must carry a SHA-256 digest");
    assert.ok(typeof iconDetect.provenance === "string" && iconDetect.provenance.length > 0, "verified icon_detect must record provenance");
  } else {
    assert.equal(iconDetect.provenance, null);
    assert.match(iconDetect.diagnostic, /not found|unverified/i);
  }
});

test("verified RapidOCR entries contain only locally measured digests", () => {
  const expected = new Map([
    ["ch_PP-OCRv3_det_infer.onnx", "3439588c030faea393a54515f51e983d8e155b19a2e8aba7891934c1cf0de526"],
    ["ch_PP-OCRv3_rec_infer.onnx", "897a3ededb38fee0dae2c1ccee38241f37df202c9509e3abca02e9217c5ee615"],
    ["ch_ppocr_mobile_v2.0_cls_infer.onnx", "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c"],
  ]);
  const rapidocrRoot = process.env.RAPIDOCR_ONNX_ROOT;
  const rapidocrArtifacts = manifest.model_artifacts.filter((artifact) => artifact.kind !== "ui_detector" && artifact.status === "verified_local");
  if (!rapidocrRoot) {
    assert.ok(rapidocrArtifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
    return;
  }
  for (const artifact of rapidocrArtifacts) {
    const fileName = artifact.path.split("/").at(-1);
    const path = join(rapidocrRoot, "models", fileName);
    assert.ok(existsSync(path), `RapidOCR model is missing: ${path}`);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(digest, expected.get(fileName), `${fileName} digest changed`);
    assert.equal(artifact.sha256, digest, `${fileName} manifest digest changed`);
  }
});

test("optional native provider probes never invoke desktop operations", async () => {
  const nativeProviders = manifest.native_providers;
  for (const provider of nativeProviders) {
    const packageName = graphProviderNames[provider.package] ?? provider.package;
    if (!Object.hasOwn(expectedOptional, packageName)) continue;
    let resolved;
    try {
      resolved = require.resolve(packageName);
    } catch (error) {
      if (error?.code === "MODULE_NOT_FOUND") continue;
      throw error;
    }
    const imported = await import(pathToFileURL(resolved).href);
    const exports = new Set(Object.keys(imported));
    if (packageName === "onnxruntime-node") {
      for (const name of ["InferenceSession", "Tensor", "env", "listSupportedBackends"]) assert.ok(exports.has(name), `${packageName} missing ${name}`);
    } else {
      assert.ok(provider.exports.some((name) => exports.has(name)), `${packageName} export contract did not load`);
    }
  }
});

test("package startup does not statically import desktop providers", () => {
  const localVision = readFileSync(join(packageRoot, "src", "providers", "local-vision.ts"), "utf8");
  for (const name of Object.keys(expectedOptional)) {
    assert.doesNotMatch(localVision, new RegExp(`from [\\\"']${name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}`));
  }
});
