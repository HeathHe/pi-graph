import assert from "node:assert/strict";
import test from "node:test";
import { createModelCatalogSnapshot } from "../src/models/model-catalog.ts";
import { compileModelRegistryManifest, type ModelRegistryManifestV2 } from "../src/models/model-registry.ts";

test("selection catalog retains virtual routers while physical projections exclude them", () => {
  const hostModels = [
    { provider: "physical", id: "vision", api: "openai-completions", input: ["text", "image"] as const },
    { provider: "selection", id: "vision", api: "pi-virtual", input: ["text", "image"] as const },
  ];
  const selection = createModelCatalogSnapshot(hostModels);
  assert.deepEqual(selection.modelIds, ["physical/vision", "selection/vision"]);
  assert.match(selection.systemPrompt, /selection\/vision.*\[vision\]/);
  const manifest: ModelRegistryManifestV2 = {
    version: 2, mode: "model-registry", default: "local", defaultModel: "default",
    backends: { local: { module: "pi-subprocess" } },
    models: { default: { modelId: "physical/default", deployment: "local", deploymentDefault: true, selector: { kind: "adapter-model", value: "physical/default" } } },
    compatibility: { version: 1, hostModelsDeployment: "local" },
  };
  const projection = compileModelRegistryManifest(manifest, { hostModels });
  assert.ok(projection.dispatch.routesByRegistrationId.has("physical/vision"));
  assert.equal(projection.dispatch.routesByRegistrationId.has("selection/vision"), false);
  const noVirtual = compileModelRegistryManifest(manifest, { hostModels: hostModels.slice(0, 1), previousIdentity: projection.discovery });
  assert.equal(noVirtual.discovery.hash, projection.discovery.hash);
});
