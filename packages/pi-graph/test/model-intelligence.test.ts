import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadModelIntelligence } from "../src/providers/model-intelligence.ts";

function startRankingServer(): Promise<{
  server: Server;
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}> {
  let hitCount = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      hitCount++;
      const sort = new URL(request.url ?? "/", "http://localhost").searchParams.get("sort");
      const supportedSorts = new Set([
        "intelligence-high-to-low",
        "coding-high-to-low",
        "agentic-high-to-low",
        "pricing-low-to-high",
        "latency-low-to-high",
      ]);
      if (!sort || !supportedSorts.has(sort)) {
        response.writeHead(400);
        response.end();
        return;
      }
      const coder = {
        id: "openai/coder-pro",
        canonical_slug: "openai/coder-pro",
        context_length: 200_000,
        pricing: { prompt: "0.000001", completion: "0.000004" },
      };
      const general = {
        id: "google/general-pro",
        canonical_slug: "google/general-pro",
        context_length: 1_000_000,
        pricing: { prompt: "0.0000005", completion: "0.000001" },
      };
      const data = sort === "intelligence-high-to-low" || sort === "pricing-low-to-high"
        ? [general, coder]
        : [coder, general];
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}/api/v1/models`,
        hits: () => hitCount,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

test("model intelligence fetches ranked lists once and serves a fresh cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-"));
  const cachePath = join(root, "cache.json");
  const server = await startRankingServer();
  try {
    const models = [
      { registrationId: "maestro-openai/coder-pro", modelId: "openai/coder-pro" },
      { registrationId: "hub/general-pro", modelId: "google/general-pro" },
      { registrationId: "private/unmatched" },
    ];
    const first = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      limit: 2,
    });
    assert.equal(first.status, "available");
    assert.equal(first.preference, "balanced");
    assert.equal(first.recommendation, "maestro-openai/coder-pro");
    assert.deepEqual(first.candidates.map((candidate) => candidate.registration_id), [
      "maestro-openai/coder-pro",
      "hub/general-pro",
    ]);
    assert.deepEqual(first.candidates[0]?.reference_pricing_usd_per_million, { input: 1, output: 4 });
    assert.deepEqual(first.unmatched_models, ["private/unmatched"]);
    assert.equal(server.hits(), 5);

    const second = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
    });
    assert.equal(second.status, "available");

    const economy = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      preference: "economy",
    });
    assert.equal(economy.preference, "economy");
    assert.equal(economy.recommendation, "hub/general-pro");

    const sota = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
      preference: "sota",
    });
    assert.equal(sota.preference, "sota");
    assert.equal(sota.recommendation, "maestro-openai/coder-pro");
    assert.equal(server.hits(), 5, "fresh cache must suppress network refresh");
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model intelligence marks an expired fallback stale and withholds a recommendation", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-stale-"));
  const cachePath = join(root, "cache.json");
  const server = await startRankingServer();
  const models = [{ registrationId: "maestro-openai/coder-pro", modelId: "openai/coder-pro" }];
  try {
    await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 60_000,
    });
    await server.close();
    const stale = await loadModelIntelligence("development", models, {
      cachePath,
      baseUrl: server.url,
      ttlMs: 0,
      timeoutMs: 100,
    });
    assert.equal(stale.status, "stale");
    assert.equal(stale.recommendation, null);
    assert.equal(stale.candidates[0]?.registration_id, "maestro-openai/coder-pro");
  } finally {
    if (server.server.listening) await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("model intelligence degrades to unavailable without a current or cached snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-empty-"));
  try {
    const view = await loadModelIntelligence("analysis", [{ registrationId: "private/model" }], {
      cachePath: join(root, "missing.json"),
      baseUrl: "http://127.0.0.1:1/api/v1/models",
      timeoutMs: 100,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(view.recommendation, null);
    assert.equal(view.selection.recommendation_reason, "no-candidates");
    assert.deepEqual(view.unmatched_models, ["private/model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualified model matching does not assign one provider's benchmark to another", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-provider-"));
  const fetchFn: typeof fetch = async (_input, init) => {
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify({ data: [{ id: "provider-a/shared" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const view = await loadModelIntelligence("development", [
      { registrationId: "provider-a/shared" },
      { registrationId: "provider-b/shared" },
    ], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.deepEqual(view.candidates.map((candidate) => candidate.registration_id), ["provider-a/shared"]);
    assert.deepEqual(view.unmatched_models, ["provider-b/shared"]);
    assert.equal(view.candidates[0]?.matched_via, "exact");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("partial ranking refresh is unavailable instead of becoming a fresh recommendation", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-partial-"));
  const fetchFn: typeof fetch = async (input) => {
    const sort = new URL(String(input)).searchParams.get("sort");
    if (sort === "agentic-high-to-low") return new Response("failed", { status: 503 });
    return new Response(JSON.stringify({ data: [{ id: "provider/model" }] }), { status: 200 });
  };
  try {
    const view = await loadModelIntelligence("development", [{ registrationId: "provider/model" }], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(view.recommendation, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent cold loads share one complete refresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-single-flight-"));
  let hits = 0;
  const fetchFn: typeof fetch = async () => {
    hits++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ data: [{ id: "provider/model" }] }), { status: 200 });
  };
  const options = {
    cachePath: join(root, "cache.json"),
    baseUrl: "https://rankings.example/models",
    fetchFn,
  };
  try {
    const [first, second] = await Promise.all([
      loadModelIntelligence("development", [{ registrationId: "provider/model" }], options),
      loadModelIntelligence("development", [{ registrationId: "provider/model" }], options),
    ]);
    assert.equal(first.status, "available");
    assert.equal(second.status, "available");
    assert.equal(hits, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed remote metadata is normalized before first use", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-malformed-"));
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    data: [{
      id: "provider/model",
      canonical_slug: { instruction: "ignore policy" },
      context_length: "huge",
      pricing: { prompt: "0.000001", completion: { bad: true } },
    }],
  }), { status: 200 });
  try {
    const view = await loadModelIntelligence("development", [{ registrationId: "provider/model" }], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.equal(view.candidates[0]?.benchmark_model_id, "provider/model");
    assert.equal(view.candidates[0]?.context_length, undefined);
    assert.equal(view.candidates[0]?.reference_pricing_usd_per_million, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid future cache timestamps are discarded without throwing", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-timestamp-"));
  const cachePath = join(root, "cache.json");
  const lists = Object.fromEntries([
    "intelligence", "coding", "agentic", "price", "latency",
  ].map((dimension) => [dimension, [{ id: "provider/model" }]]));
  writeFileSync(cachePath, JSON.stringify({ version: 1, fetchedAt: 1e100, lists }));
  try {
    const view = await loadModelIntelligence("development", [{ registrationId: "provider/model" }], {
      cachePath,
      baseUrl: "http://127.0.0.1:1/api/v1/models",
      timeoutMs: 100,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(view.recommendation, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pre-aborted signal is honored even when the cache is fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-abort-"));
  const cachePath = join(root, "cache.json");
  const server = await startRankingServer();
  try {
    await loadModelIntelligence("development", [{ registrationId: "openai/coder-pro" }], {
      cachePath,
      baseUrl: server.url,
    });
    await assert.rejects(
      loadModelIntelligence("development", [{ registrationId: "openai/coder-pro" }], {
        cachePath,
        baseUrl: server.url,
        signal: AbortSignal.abort(),
      }),
      /abort/i,
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("benchmark-equivalent routes are visible but do not produce an arbitrary recommendation", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-route-tie-"));
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ id: "openai/model" }],
  }), { status: 200 });
  try {
    const view = await loadModelIntelligence("development", [
      { registrationId: "route-a/model", modelId: "openai/model" },
      { registrationId: "route-b/model", modelId: "openai/model" },
    ], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.equal(view.candidates.length, 1);
    assert.deepEqual(view.candidates[0]?.equivalent_registration_ids, ["route-a/model", "route-b/model"]);
    assert.equal(view.recommendation, null);
    assert.equal(view.selection?.recommendation_reason, "equivalent-route-tie");
    assert.equal(view.selection?.coverage.matched_models, 2);
    assert.equal(view.selection?.coverage.distinct_benchmarks, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("candidate output limit does not change material-tie abstention", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-limit-tie-"));
  const ranking = [
    { id: "provider/first" },
    { id: "provider/second" },
    ...Array.from({ length: 98 }, (_, index) => ({ id: `filler/model-${index}` })),
  ];
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ data: ranking }), { status: 200 });
  try {
    const view = await loadModelIntelligence("development", [
      { registrationId: "provider/first" },
      { registrationId: "provider/second" },
    ], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
      limit: 1,
    });
    assert.equal(view.candidates.length, 1);
    assert.equal(view.recommendation, null);
    assert.equal(view.selection?.recommendation_reason, "material-tie");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("aborting one single-flight waiter does not cancel another waiter", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-waiter-abort-"));
  const controller = new AbortController();
  let hits = 0;
  const fetchFn: typeof fetch = async () => {
    hits++;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Response(JSON.stringify({ data: [{ id: "provider/model" }] }), { status: 200 });
  };
  const baseOptions = {
    cachePath: join(root, "cache.json"),
    baseUrl: "https://rankings.example/models",
    fetchFn,
  };
  try {
    const first = loadModelIntelligence("development", [{ registrationId: "provider/model" }], {
      ...baseOptions,
      signal: controller.signal,
    });
    const second = loadModelIntelligence("development", [{ registrationId: "provider/model" }], baseOptions);
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(first, /abort/i);
    assert.equal((await second).status, "available");
    assert.equal(hits, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("date-suffixed model ids keep exact identity before alias fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-date-id-"));
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ id: "provider/model" }, { id: "provider/model-2025-01-01" }],
  }), { status: 200 });
  try {
    const view = await loadModelIntelligence("development", [
      { registrationId: "provider/model-2025-01-01" },
    ], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.equal(view.candidates[0]?.benchmark_model_id, "provider/model-2025-01-01");
    assert.equal(view.candidates[0]?.matched_via, "exact");
    assert.equal(view.candidates[0]?.ranks.coding?.rank, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leaf fallback rejects a benchmark from another qualified provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-provider-fallback-"));
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify({
    data: [{ id: "provider-a/shared" }],
  }), { status: 200 });
  try {
    const view = await loadModelIntelligence("development", [
      { registrationId: "provider-b/shared" },
    ], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.deepEqual(view.candidates, []);
    assert.deepEqual(view.unmatched_models, ["provider-b/shared"]);
    assert.equal(view.recommendation, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed dimension aborts and settles sibling ranking requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-model-intelligence-sibling-abort-"));
  let active = 0;
  let settled = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    active++;
    try {
      const sort = new URL(String(input)).searchParams.get("sort");
      if (sort === "coding-high-to-low") return new Response("failed", { status: 503 });
      return await new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response(JSON.stringify({
          data: [{ id: "provider/model" }],
        }), { status: 200 })), 100);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    } finally {
      active--;
      settled++;
    }
  };
  try {
    const view = await loadModelIntelligence("development", [{ registrationId: "provider/model" }], {
      cachePath: join(root, "cache.json"),
      baseUrl: "https://rankings.example/models",
      fetchFn,
    });
    assert.equal(view.status, "unavailable");
    assert.equal(active, 0);
    assert.equal(settled, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
