import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import { configuredProviderRegistration } from "../src/providers/api-provider-ops.ts";
import { applyModelFilters, recordProviderResponse, registerApiProviderConfigs } from "../src/providers/api-provider-config.ts";
import { analyzeAttachedImage, loadVisionDelegationConfig, saveVisionDelegationConfig } from "../src/providers/vision-assist.ts";

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const selection: Model<"pi-virtual"> = { type: "chat", provider: "virtual", id: "vision", name: "Virtual Vision", api: "pi-virtual", baseUrl: "", input: ["text", "image"], reasoning: false, contextWindow: 100000, maxTokens: 10000, cost };
const png = { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString("base64"), mimeType: "image/png" };
function assistant(): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "routed image" }], api: "openai-completions", provider: "physical", model: "vision", stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } }, timestamp: 0 };
}

test("native registration preserves multi-operation models.json and leaves unsupported filters non-destructive", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-catalog-"));
  try {
    const modelsPath = join(dir, "models.json");
    const catalog = [{ id: "chat", type: "chat" }, { id: "image", type: "image" }, { id: "classify", type: "classifier" }];
    writeFileSync(modelsPath, JSON.stringify({ providers: { mixed: { baseUrl: "https://example.com/v1", apiKey: "key", models: catalog } } }));
    const native = configuredProviderRegistration("mixed", modelsPath, "0.99.0");
    assert.equal(native.models, undefined);
    assert.equal(native.oauth, undefined);
    assert.equal(native.apiKey, "key");
    assert.equal(configuredProviderRegistration("mixed", modelsPath, "0.98.0").models?.length, 3);
    const defaultsPath = join(dir, "api-manager.json");
    writeFileSync(defaultsPath, JSON.stringify({ modelFilters: { mixed: { mode: "allow", patterns: ["chat"] } } }));
    const registrations: ProviderConfig[] = [];
    const notices: string[] = [];
    const pi = { registerProvider: (_provider: string, config: ProviderConfig) => registrations.push(config) } as unknown as ExtensionAPI;
    const ctx = { modelRegistry: { getAvailable: () => [selection] }, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
    await applyModelFilters(pi, ctx, defaultsPath);
    assert.equal(registrations.length, 0);
    assert.match(notices[0], /image\/classifier/);
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, "utf8")).providers.mixed.models, catalog);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("virtual Vision executes the host direct router without selection auth or compat complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-vision-"));
  try {
    saveVisionDelegationConfig({ ...loadVisionDelegationConfig(dir), visionModel: "virtual/vision" }, dir);
    let calls = 0;
    const ctx = { cwd: dir, model: selection, modelRegistry: {
      getAvailable: () => [selection], find: () => selection,
      getApiKeyAndHeaders: () => { throw new Error("selection auth must not run"); },
      streamSimple: (model: Model<"pi-virtual">, context: unknown, options: { apiKey?: string; headers?: unknown }) => {
        assert.equal(model, selection); assert.ok(context); assert.equal(options.apiKey, undefined); assert.equal(options.headers, undefined);
        calls++; return { result: async () => assistant() };
      },
    } } as unknown as ExtensionContext;
    const response = await analyzeAttachedImage(ctx, png, { agentDir: dir, hostVersion: "0.99.0", completeFn: async () => { throw new Error("compat must not execute"); } });
    assert.equal(response.model, "physical/vision");
    assert.equal(response.text, "routed image");
    assert.equal(calls, 1);
    assert.equal((await analyzeAttachedImage(ctx, png, { agentDir: dir, hostVersion: "0.99.0" })).cached, true);
    assert.equal(calls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unknown/native missing Vision runtime never falls back to legacy completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unavailable-vision-"));
  try {
    const ctx = { cwd: dir, modelRegistry: { getAvailable: () => [selection], find: () => selection } } as unknown as ExtensionContext;
    for (const hostVersion of ["0.99.0", "unknown"]) {
      await assert.rejects(analyzeAttachedImage(ctx, png, { agentDir: dir, hostVersion, completeFn: async () => { throw new Error("unexpected compat fallback"); } }), /runtime unavailable/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API-key failure attribution uses dispatch provider, never the virtual selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dispatch-auth-"));
  try {
    const modelsPath = join(dir, "models.json");
    const provider = { baseUrl: "https://example.com/v1", models: [{ id: "vision" }], activeKeyId: "a", apiKeys: [{ id: "a", key: "a-key" }, { id: "b", key: "b-key" }] };
    writeFileSync(modelsPath, JSON.stringify({ providers: { physical: provider, virtual: provider } }));
    const ctx = { model: selection, modelRegistry: { refresh: async () => undefined }, ui: { notify: () => undefined } } as unknown as ExtensionContext;
    const pi = { registerProvider: () => undefined, on: () => undefined } as unknown as ExtensionAPI;
    await recordProviderResponse(pi, "physical", 401, ctx, modelsPath);
    const saved = JSON.parse(readFileSync(modelsPath, "utf8"));
    assert.equal(saved.providers.physical.activeKeyId, "b");
    assert.equal(saved.providers.virtual.activeKeyId, "a");
    const handlers = new Map<string, (event: { status: number }, context: ExtensionContext) => Promise<void>>();
    registerApiProviderConfigs({ ...pi, registerCommand: () => undefined, on: (name: string, handler: typeof handlers extends Map<string, infer V> ? V : never) => handlers.set(name, handler) } as unknown as ExtensionAPI, { modelsPath, hostVersion: "0.99.0" });
    await handlers.get("after_provider_response")?.({ status: 401 }, ctx);
    assert.equal(JSON.parse(readFileSync(modelsPath, "utf8")).providers.virtual.activeKeyId, "a");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
