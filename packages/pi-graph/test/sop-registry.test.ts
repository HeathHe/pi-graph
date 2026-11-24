import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SopRegistry, type EmbeddedBaselines } from "../src/tools/sop/sop-registry.ts";
import { BROWSER_HELPER_QUICKREF, BROWSER_SOPS_BASELINE } from "../src/tools/sop/embedded/browser.ts";

const EMBEDDED: EmbeddedBaselines = {
  browser: {
    core: { title: "Embedded core", body: "embedded core body" },
    safety: { title: "Embedded safety", body: "embedded safety body" },
  },
  computer_use: {
    core: { title: "Embedded CU core", body: "embedded cu core body" },
  },
};

async function withKnowhowDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-sop-registry-"));
  const dir = join(root, ".workflow", "knowhow");
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return root;
}

function sopDoc(tool: string, topic: string, title: string, body: string, order = 0): string {
  return `---
title: ${title}
type: recipe
tools: [${tool}]
sop_topic: ${topic}
sop_order: ${order}
---

${body}
`;
}

test("SopRegistry serves embedded baseline when knowhow dir is empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-sop-registry-empty-"));
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    assert.deepEqual(registry.topics("browser"), ["core", "safety"]);
    assert.equal(registry.get("browser", "core")?.body, "embedded core body");
    assert.equal(registry.get("browser", "core")?.source, "embedded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry external knowhow overrides embedded on equal order", async () => {
  const root = await withKnowhowDir({
    "RCP-browser-core.md": sopDoc("browser", "core", "External core", "external core body", 0),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    const doc = registry.get("browser", "core");
    assert.equal(doc?.body, "external core body");
    assert.equal(doc?.source, "knowhow");
    // Non-overridden embedded topic still served.
    assert.equal(registry.get("browser", "safety")?.body, "embedded safety body");
    assert.equal(registry.get("browser", "safety")?.source, "embedded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry higher order wins over lower order external", async () => {
  const root = await withKnowhowDir({
    "RCP-low.md": sopDoc("browser", "core", "Low", "low body", 1),
    "RCP-high.md": sopDoc("browser", "core", "High", "high body", 5),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    assert.equal(registry.get("browser", "core")?.body, "high body");
    assert.equal(registry.get("browser", "core")?.title, "High");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry published content hints participate in existing order and lifecycle rules", async () => {
  const published = (body: string, title: string, lifecycle = "active") => `---\ntitle: ${title}\ntype: recipe\nlifecycleStatus: ${lifecycle}\n---\n\n${body}`;
  const root = await withKnowhowDir({
    "RCP-legacy.md": sopDoc("browser", "core", "Old", "old core body", 0),
    "RCP-published.md": published(sopDoc("browser", "core", "Hint label", "new full SOP body", 1), "Published core"),
    "RCP-retired.md": published(sopDoc("browser", "core", "Retired", "retired body", 100), "Retired", "deprecated"),
    "RCP-equal.md": published(sopDoc("browser", "safety", "Hint", "external safety body", 0), "Published safety"),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    const core = registry.get("browser", "core");
    assert.equal(core?.source, "knowhow");
    assert.equal(core?.body, "new full SOP body");
    assert.equal(core?.title, "Published core");
    assert.match(core?.filePath ?? "", /RCP-published\.md$/);
    assert.equal(registry.get("browser", "safety")?.body, "external safety body", "equal-order external still overrides embedded");
    assert.equal(registry.get("computer_use", "core")?.body, "embedded cu core body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry lower-order external does not override higher-order external", async () => {
  const root = await withKnowhowDir({
    "RCP-high.md": sopDoc("browser", "core", "High", "high body", 10),
    "RCP-low.md": sopDoc("browser", "core", "Low", "low body", 2),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    assert.equal(registry.get("browser", "core")?.body, "high body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry adds a brand-new topic not in embedded", async () => {
  const root = await withKnowhowDir({
    "RCP-new.md": sopDoc("browser", "captcha-strategies", "Captcha", "captcha body", 0),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    assert.deepEqual(registry.topics("browser"), ["captcha-strategies", "core", "safety"]);
    assert.equal(registry.get("browser", "captcha-strategies")?.body, "captcha body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry renderIndex produces a sorted topic listing", async () => {
  const root = await withKnowhowDir({
    "RCP-extra.md": sopDoc("browser", "antibot", "Antibot", "antibot body", 0),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    const index = registry.renderIndex("browser", (n) => `Browser SOP Registry — ${n} documents.`);
    assert.match(index, /Browser SOP Registry — 3 documents\./);
    assert.match(index, /antibot\s+Antibot/);
    assert.match(index, /core\s+Embedded core/);
    assert.match(index, /safety\s+Embedded safety/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser timeout recovery SOP covers dialogs, bounded evidence and non-replay", () => {
  const core = BROWSER_SOPS_BASELINE.core.body;
  const automation = BROWSER_SOPS_BASELINE["automation-antipatterns"].body;
  assert.match(core, /Omitting the policy installs no automatic handler/);
  assert.match(core, /custom handlers must await dialog\.accept\(\) or dialog\.dismiss\(\)/);
  assert.match(core, /never silently auto-accept destructive confirmations/);
  assert.match(core, /bounded partial text output and screenshot metadata/);
  assert.match(core, /raw ElementHandle\/keyboard\/CDPSession\/custom host awaits are not/);
  assert.match(core, /browser\.target\(\)\.createCDPSession\(\)/);
  assert.match(core, /BEFORE triggering export/);
  assert.match(core, /Do not use page-target tab\.waitForCdp for Browser-domain events/);
  assert.match(core, /Extension failures do not provide these Puppeteer diagnostics/);
  assert.match(automation, /borrowed profile\/CDP pages are not closed/);
  assert.match(automation, /Never kill a borrowed browser/);
  assert.match(automation, /Do not count only explicit waitFor timeouts/);
  assert.match(automation, /Raising the default cannot fix a run that explicitly sets timeout/);
  assert.match(automation, /responsive HTTP endpoint does not prove the renderer or CDP is responsive/);
  assert.match(automation, /not replaying the entire submission/);
});

test("browser guide index retains timeout recovery contracts under external topic overrides", async () => {
  const root = await withKnowhowDir({
    "RCP-core.md": sopDoc("browser", "core", "Custom core", "custom core body", 1),
    "RCP-automation.md": sopDoc("browser", "automation-antipatterns", "Custom automation", "custom automation body", 1),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: { browser: BROWSER_SOPS_BASELINE } });
    await registry.ensureLoaded();
    assert.equal(registry.get("browser", "core")?.body, "custom core body");
    const index = registry.renderIndex("browser", (n) => `Browser SOP Registry — ${n} documents.`, BROWSER_HELPER_QUICKREF);
    assert.match(index, /Managed\/profile\/CDP run failures retain bounded partial output\/operation\/timing diagnostics/);
    assert.match(index, /Extension command\/execution waits are bounded but setup\/postprocessing may add latency/);
    assert.match(index, /borrowed profile\/CDP pages only disconnect and may continue executing/);
    assert.match(index, /recording-only dialog listener can leave native prompts blocking/);
    assert.match(index, /never blindly replay submit/);
    assert.match(index, /Configure downloads before export/);
    assert.match(index, /cleanup can add latency/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SopRegistry invalidate forces a reload", async () => {
  const root = await withKnowhowDir({
    "RCP-v1.md": sopDoc("browser", "core", "V1", "v1 body", 0),
  });
  try {
    const registry = new SopRegistry({ cwd: root, embedded: EMBEDDED });
    await registry.ensureLoaded();
    assert.equal(registry.get("browser", "core")?.body, "v1 body");
    // External file changes are visible after invalidate + ensureLoaded (raw cache keyed on mtime/size).
    await writeFile(join(root, ".workflow", "knowhow", "RCP-v1.md"), sopDoc("browser", "core", "V2", "v2 body", 0));
    registry.invalidate();
    await registry.ensureLoaded();
    assert.equal(registry.get("browser", "core")?.body, "v2 body");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
