import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualTemporaryDirectory, VisualEvidenceLeaseStore, visualEvidenceTask } from "../src/subagent-router/visual-evidence.ts";

function pngBytes(label: string): Buffer {
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(label)]);
}

test("visual evidence leases bind integrity-verified snapshots to one session, workspace, and Agent", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input-1.png");
	await writeFile(path, pngBytes("image-one"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore();
	const lease = await store.create({
		sessionId: "session-1",
		cwd: process.cwd(),
		originalPrompt: "检查页面布局",
		paths: [canonical],
		sourceLabels: new Map([[canonical, "attached-image-1"]]),
		directories: [directory],
		allowedAgents: ["interaction-designer"],
	});
	try {
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-2", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "wrong-session", originalPrompt: "检查页面布局" }), /not bound to this session/);
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "product-manager", toolCallId: "wrong-agent", originalPrompt: "检查页面布局" }), /not authorized/);
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "wrong-prompt", originalPrompt: "读取所有文字" }), /not bound to this original user request/);
		const firstResolution = store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch-1", originalPrompt: "检查页面布局" });
		assert.equal((await firstResolution).id, lease.id);
		assert.equal(store.getAsset(lease.assetId)?.activeLeaseCount, 1, "dispatch must become active before asynchronous image-file verification completes");
		assert.equal((await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch-1", originalPrompt: "检查页面布局" })).id, lease.id, "the same dispatch identity may resume idempotently");
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "replay", originalPrompt: "检查页面布局" }), /different tool call/);
		const task = visualEvidenceTask("分析排版", lease);
		assert.match(task, /Use the read tool to inspect every image path/);
		assert.match(task, new RegExp(lease.id));
		assert.doesNotMatch(task, /aW1hZ2Utb25l/u, "the task must carry a verified path manifest, not image base64");
		await writeFile(canonical, pngBytes("tampered"), { mode: 0o600 });
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch-1", originalPrompt: "检查页面布局" }), /integrity verification failed/);
		assert.equal(existsSync(directory), false, "an integrity failure must revoke and remove the compromised asset");
	} finally {
		await store.releaseAll();
	}
	assert.equal(existsSync(directory), false, "releasing a lease must remove its controlled snapshot directory");
});

test("two concurrent tool calls cannot both consume one issued visual Lease", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("concurrent-consume"), { mode: 0o600 });
	const store = new VisualEvidenceLeaseStore();
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	const results = await Promise.allSettled([
		store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch-a", originalPrompt: "inspect" }),
		store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch-b", originalPrompt: "inspect" }),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	await store.releaseAll();
});

test("visual evidence leases reject broad or non-owned cleanup directories", async () => {
	const directory = await mkdtemp(join(tmpdir(), "unowned-images-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("image"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore();
	try {
		await assert.rejects(() => store.create({
			sessionId: "session-1",
			cwd: process.cwd(),
			originalPrompt: "inspect",
			paths: [canonical],
			sourceLabels: new Map(),
			directories: [directory],
			allowedAgents: ["interaction-designer"],
		}), /unsafe temporary directory/);
		assert.equal(existsSync(directory), true, "the store must not delete a directory it refused to own");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("one retained visual asset issues different single-turn handles without deleting the snapshot", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("reusable-image"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore();
	const first = await store.create({
		sessionId: "session-1",
		cwd: process.cwd(),
		originalPrompt: "检查页面布局",
		paths: [canonical],
		sourceLabels: new Map([[canonical, "attached-image-1"]]),
		directories: [directory],
		allowedAgents: ["interaction-designer"],
	});
	store.releaseLease(first.id);
	assert.equal(existsSync(directory), true, "ending one turn must retain the controlled asset for a bounded follow-up window");
	await assert.rejects(() => store.resolve(first.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "old", originalPrompt: "检查页面布局" }), /already released/);
	const second = await store.issueLease(first.assetId, {
		sessionId: "session-1",
		cwd: process.cwd(),
		originalPrompt: "分组交互呢？",
		allowedAgents: ["interaction-designer"],
	});
	assert.notEqual(second.id, first.id);
	assert.equal(second.assetId, first.assetId);
	assert.equal((await store.resolve(second.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "second", originalPrompt: "分组交互呢？" })).id, second.id);
	await store.releaseAll();
	assert.equal(existsSync(directory), false);
});

test("successful activity slides the idle deadline but never the absolute deadline", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("sliding"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	assert.equal(lease.expiresAt, startedAt + 15_000, "an active task must remain protected until the idle deadline plus execution grace");
	now = startedAt + 9_500;
	await store.releaseExpired();
	assert.equal(existsSync(directory), true, "an active consumed lease must pin an otherwise idle-expired asset");
	const renewed = await store.renewAsset(lease.assetId);
	assert.equal(renewed?.idleExpiresAt, startedAt + 19_500);
	assert.equal(renewed?.absoluteExpiresAt, startedAt + 30_000);
	store.releaseLease(lease.id);
	now = startedAt + 19_000;
	const second = await store.issueLease(lease.assetId, { sessionId: "session-1", cwd: process.cwd(), originalPrompt: "continue", allowedAgents: ["interaction-designer"] });
	await store.resolve(second.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "second", originalPrompt: "continue" });
	assert.equal((await store.renewAsset(lease.assetId))?.idleExpiresAt, startedAt + 29_000);
	store.releaseLease(second.id);
	now = startedAt + 28_500;
	const third = await store.issueLease(lease.assetId, { sessionId: "session-1", cwd: process.cwd(), originalPrompt: "continue again", allowedAgents: ["interaction-designer"] });
	await store.resolve(third.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "third", originalPrompt: "continue again" });
	const renewedAgain = await store.renewAsset(lease.assetId);
	assert.equal(renewedAgain?.idleExpiresAt, startedAt + 30_000, "sliding renewal must clamp to the absolute deadline");
	store.releaseLease(third.id);
	now = startedAt + 30_000;
	await store.releaseExpired();
	assert.equal(existsSync(directory), false);
});

test("successful analyzer activity renews an unconsumed domain lease for the same turn", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("analyzer-handoff"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, issuedLeaseTtlMs: 10_000, activeGraceMs: 5_000 });
	const domainLease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const analyzerLease = await store.issueLease(domainLease.assetId, {
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", allowedAgents: ["multimodal-analyzer"],
	});
	await store.resolve(analyzerLease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "multimodal-analyzer", toolCallId: "analyzer", originalPrompt: "inspect" });
	now = startedAt + 5_000;
	const renewed = await store.renewAsset(domainLease.assetId);
	assert.equal(renewed?.idleExpiresAt, startedAt + 15_000);
	assert.equal(domainLease.expiresAt, startedAt + 15_000, "the domain handoff must not retain the pre-analysis deadline");
	store.releaseLease(analyzerLease.id);
	now = startedAt + 11_000;
	assert.equal((await store.resolve(domainLease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "domain", originalPrompt: "inspect" })).id, domainLease.id);
	await store.releaseAll();
});

test("an analyzer finishing inside idle grace renews before releasing its active lease", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("grace-handoff"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const domainLease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const analyzerLease = await store.issueLease(domainLease.assetId, {
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", allowedAgents: ["multimodal-analyzer"],
	});
	await store.resolve(analyzerLease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "multimodal-analyzer", toolCallId: "analyzer", originalPrompt: "inspect" });
	now = startedAt + 10_500;
	await store.expireAsset(domainLease.assetId, "expired_idle");
	assert.equal(existsSync(directory), true);
	assert.ok(await store.renewAfterSuccessfulLease(analyzerLease.id, "analyzer"));
	await assert.rejects(() => store.resolve(domainLease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "expired-domain", originalPrompt: "inspect" }), /already released/);
	const replacementDomainLease = await store.issueLease(domainLease.assetId, {
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", allowedAgents: ["interaction-designer"],
	});
	store.releaseLease(analyzerLease.id);
	await Promise.resolve();
	assert.equal(existsSync(directory), true, "successful in-grace handoff must cancel pending expiry before the active lease is released");
	assert.equal((await store.resolve(replacementDomainLease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "domain", originalPrompt: "inspect" })).id, replacementDomainLease.id);
	await store.releaseAll();
});

test("releaseExpired enforces the consumed lease grace deadline even when its timer was delayed", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("delayed-timer"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	now = startedAt + 15_000;
	await store.releaseExpired();
	assert.equal(existsSync(directory), false, "the maximum execution grace must not depend only on a timely setTimeout callback");
});

test("a delayed success cannot renew a lease after its execution grace", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("late-success"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	now = startedAt + 15_001;
	await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" }), /expired before dispatch or idempotent recovery/);
	assert.equal(await store.renewAfterSuccessfulLease(lease.id, "dispatch"), undefined);
	assert.equal(existsSync(directory), false, "a late callback must revoke and delete instead of reviving the asset");
});

test("workspace binding rejects a cwd symlink retargeted after lease creation", async () => {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-visual-workspace-"));
	const firstWorkspace = join(workspaceRoot, "first");
	const secondWorkspace = join(workspaceRoot, "second");
	const linkedWorkspace = join(workspaceRoot, "current");
	await mkdir(firstWorkspace);
	await mkdir(secondWorkspace);
	await symlink(firstWorkspace, linkedWorkspace);
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("cwd-swap"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore();
	const lease = await store.create({
		sessionId: "session-1", cwd: linkedWorkspace, originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	try {
		await rm(linkedWorkspace, { force: true });
		await symlink(secondWorkspace, linkedWorkspace);
		await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: linkedWorkspace, agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" }), /not bound to this session and workspace/);
	} finally {
		await store.releaseAll();
		await rm(workspaceRoot, { recursive: true, force: true });
	}
});

test("staging directories are marked before image bytes and remain recoverable after a crash", async () => {
	const startedAt = Date.now();
	const directory = await createVisualTemporaryDirectory("pi-auto-vision-", { now: () => startedAt, idleTtlMs: 1_000, absoluteTtlMs: 3_000 });
	await writeFile(join(directory, "input.png"), pngBytes("staging-crash"), { mode: 0o600 });
	const markerPath = join(directory, ".pi-graph-visual-asset.json");
	const marker = JSON.parse(await readFile(markerPath, "utf8"));
	assert.equal(marker.idleExpiresAt, startedAt + 1_000);
	assert.equal(marker.absoluteExpiresAt, startedAt + 3_000);
	await writeFile(markerPath, JSON.stringify({ ...marker, cleanupAt: startedAt - 1 }), { mode: 0o600 });
	const recoveryStore = new VisualEvidenceLeaseStore({ now: () => startedAt });
	assert.deepEqual(await recoveryStore.sweepOrphanedAssets(), []);
	assert.equal(existsSync(directory), false, "a crash between byte creation and asset activation must not leave an unmarked permanent orphan");
});

test("the absolute deadline deletes an active asset without adding execution grace", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("absolute-hard-cap"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 30_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	now = startedAt + 29_500;
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	assert.equal(lease.expiresAt, startedAt + 30_000, "the consumed lease must clamp to the original absolute deadline");
	now = startedAt + 30_000;
	await assert.rejects(() => store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" }), /expired before dispatch or idempotent recovery/);
	assert.equal(existsSync(directory), false, "30 minutes from creation is a hard storage limit even for an active task");
});

test("store retention ceilings cannot be relaxed by conflicting or per-asset TTL input", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("policy-ceiling"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 5_000 });
	const lease = await store.create({
		sessionId: "session-1",
		cwd: process.cwd(),
		originalPrompt: "inspect",
		paths: [canonical],
		sourceLabels: new Map(),
		directories: [directory],
		allowedAgents: ["interaction-designer"],
		idleTtlMs: 20_000,
		absoluteTtlMs: 20_000,
	});
	const retained = store.getAsset(lease.assetId);
	assert.equal(retained?.idleExpiresAt, startedAt + 5_000);
	assert.equal(retained?.absoluteExpiresAt, startedAt + 5_000);
	now = startedAt + 5_000;
	await store.releaseExpired();
	assert.equal(existsSync(directory), false);
});

test("non-finite retention options fall back to bounded defaults", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("finite-policy"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({
		now: () => now,
		idleTtlMs: Number.NaN,
		absoluteTtlMs: Number.POSITIVE_INFINITY,
		issuedLeaseTtlMs: Number.NaN,
		activeGraceMs: Number.POSITIVE_INFINITY,
		cleanupRetryMs: Number.NaN,
	});
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
		idleTtlMs: Number.POSITIVE_INFINITY,
		absoluteTtlMs: Number.NaN,
	});
	const retained = store.getAsset(lease.assetId);
	assert.equal(retained?.idleExpiresAt, startedAt + 600_000);
	assert.equal(retained?.absoluteExpiresAt, startedAt + 1_800_000);
	assert.equal(lease.expiresAt, startedAt + 600_000);
	await store.releaseAll();
});

test("finite store options may tighten but cannot relax the product retention ceilings", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("fixed-ceilings"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({
		now: () => now,
		idleTtlMs: 60 * 60_000,
		absoluteTtlMs: 60 * 60_000,
		issuedLeaseTtlMs: 60 * 60_000,
		activeGraceMs: 60 * 60_000,
	});
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const retained = store.getAsset(lease.assetId);
	assert.equal(retained?.idleExpiresAt, startedAt + 10 * 60_000);
	assert.equal(retained?.absoluteExpiresAt, startedAt + 30 * 60_000);
	assert.equal(lease.expiresAt, startedAt + 10 * 60_000);
	now = startedAt + 9 * 60_000;
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	assert.equal(lease.expiresAt, startedAt + 15 * 60_000, "active execution grace must remain capped at five minutes beyond the idle deadline");
	await store.releaseAll();
});

test("strict retention does not retain a successful asset for a follow-up turn", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("strict"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, retentionMode: "strict" });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	now = startedAt + 5_000;
	assert.equal((await store.renewAsset(lease.assetId))?.idleExpiresAt, startedAt + 15_000, "strict mode may keep the current in-flight turn alive before deleting at turn end");
	assert.equal(store.retainsSuccessfulAssets(), false);
	store.releaseLease(lease.id);
	await store.releaseAsset(lease.assetId);
	assert.equal(existsSync(directory), false);
});

test("an asset cannot report a successful renewal after deletion has started", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("delete-renew-race"), { mode: 0o600 });
	const canonical = await realpath(path);
	let allowDeletion!: () => void;
	const deletionGate = new Promise<void>((resolve) => { allowDeletion = resolve; });
	const store = new VisualEvidenceLeaseStore({
		removeDirectory: async (target) => {
			await deletionGate;
			await rm(target, { recursive: true, force: true });
		},
	});
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const deleting = store.releaseAsset(lease.assetId);
	assert.equal(await store.renewAsset(lease.assetId), undefined, "renewal must fail closed once the serialized deletion operation owns the asset");
	allowDeletion();
	assert.deepEqual(await deleting, []);
	assert.equal(existsSync(directory), false);
});

test("an accepted follow-up cannot renew after crossing the old idle deadline", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("idle-boundary"), { mode: 0o600 });
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000 });
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	now = startedAt + 10_001;
	assert.equal(await store.renewForAcceptedFollowUp(lease.assetId), undefined);
	await store.releaseAll();
});

test("an accepted follow-up cannot cross its old idle deadline during marker I/O", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("idle-marker-boundary"), { mode: 0o600 });
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000 });
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	let allowMarker!: () => void;
	const markerGate = new Promise<void>((resolve) => { allowMarker = resolve; });
	(store as any).writeOwnershipMarkers = async () => markerGate;
	now = startedAt + 9_999;
	const renewing = store.renewForAcceptedFollowUp(lease.assetId);
	await Promise.resolve();
	now = startedAt + 10_000;
	allowMarker();
	assert.equal(await renewing, undefined);
	assert.equal(store.getAsset(lease.assetId), undefined);
});

test("renewal rechecks irreversible deletion after asynchronous marker I/O", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("renew-post-await"), { mode: 0o600 });
	let allowDeletion!: () => void;
	const deletionGate = new Promise<void>((resolve) => { allowDeletion = resolve; });
	const store = new VisualEvidenceLeaseStore({ removeDirectory: async (target) => { await deletionGate; await rm(target, { recursive: true, force: true }); } });
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	let allowMarker!: () => void;
	const markerGate = new Promise<void>((resolve) => { allowMarker = resolve; });
	(store as any).writeOwnershipMarkers = async () => markerGate;
	const renewing = store.renewForAcceptedFollowUp(lease.assetId);
	await Promise.resolve();
	const deleting = store.releaseAsset(lease.assetId);
	allowMarker();
	assert.equal(await renewing, undefined, "renewal must recheck deletion ownership after marker I/O returns");
	allowDeletion();
	await deleting;
});

test("successful completion cannot renew after its consumed Lease grace expires during marker I/O", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("lease-grace-post-await"), { mode: 0o600 });
	const store = new VisualEvidenceLeaseStore({ now: () => now, idleTtlMs: 10_000, absoluteTtlMs: 30_000, activeGraceMs: 5_000 });
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	let allowMarker!: () => void;
	const markerGate = new Promise<void>((resolve) => { allowMarker = resolve; });
	(store as any).writeOwnershipMarkers = async () => markerGate;
	const renewing = store.renewAfterSuccessfulLease(lease.id, "dispatch");
	await Promise.resolve();
	now = lease.expiresAt;
	allowMarker();
	assert.equal(await renewing, undefined, "the result acceptance boundary must be checked again after marker I/O");
	assert.equal(store.getAsset(lease.assetId), undefined);
});

test("successful completion cannot commit renewal after its consumed Lease is revoked during marker I/O", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("lease-revoked-post-await"), { mode: 0o600 });
	const store = new VisualEvidenceLeaseStore();
	const lease = await store.create({ sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [await realpath(path)], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"] });
	await store.resolve(lease.id, { sessionId: "session-1", cwd: process.cwd(), agent: "interaction-designer", toolCallId: "dispatch", originalPrompt: "inspect" });
	let allowMarker!: () => void;
	const markerGate = new Promise<void>((resolve) => { allowMarker = resolve; });
	(store as any).writeOwnershipMarkers = async () => markerGate;
	const renewing = store.renewAfterSuccessfulLease(lease.id, "dispatch");
	await Promise.resolve();
	store.releaseLease(lease.id);
	allowMarker();
	assert.equal(await renewing, undefined);
	assert.equal(store.getAsset(lease.assetId), undefined, "revocation during commit must fail closed and release the asset");
});

test("cleanup refuses to delete a replacement directory with a different inode", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const displaced = `${directory}.displaced`;
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("directory-swap"), { mode: 0o600 });
	const canonical = await realpath(path);
	const store = new VisualEvidenceLeaseStore({ cleanupRetryMs: 60_000 });
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	try {
		await rename(directory, displaced);
		await mkdir(directory);
		await writeFile(join(directory, "unrelated.txt"), "must survive");
		const failures = await store.releaseAsset(lease.assetId);
		assert.equal(failures.length, 1);
		assert.equal(existsSync(join(directory, "unrelated.txt")), true, "cleanup must not delete a path replacement that fails the recorded inode check");
		assert.equal(existsSync(displaced), true);
	} finally {
		await rm(directory, { recursive: true, force: true });
		await rm(displaced, { recursive: true, force: true });
	}
});

test("a failed cleanup remains revoked and retries from retained state", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("cleanup-retry"), { mode: 0o600 });
	const canonicalDirectory = await realpath(directory);
	const canonical = await realpath(path);
	let attempts = 0;
	const store = new VisualEvidenceLeaseStore({
		cleanupRetryMs: 60_000,
		removeDirectory: async (target) => {
			if (!target.startsWith(`${canonicalDirectory}.deleting-`)) {
				await rm(target, { recursive: true, force: true });
				return;
			}
			attempts += 1;
			if (attempts <= 2) throw new Error("simulated cleanup failure");
			await rm(target, { recursive: true, force: true });
		},
	});
	const lease = await store.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const firstFailures = await store.releaseAsset(lease.assetId);
	assert.equal(firstFailures.length, 1);
	assert.match(firstFailures[0]!, new RegExp(`${canonicalDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.deleting-`, "u"));
	assert.equal(await store.renewAsset(lease.assetId), undefined, "a failed filesystem cleanup must not make the revoked asset renewable");
	await assert.rejects(() => store.issueLease(lease.assetId, { sessionId: "session-1", cwd: process.cwd(), originalPrompt: "replay", allowedAgents: ["interaction-designer"] }), /pending deletion|unknown or expired/);
	for (let index = 0; index < 3 && attempts < 3; index += 1) await store.releaseExpired();
	assert.ok(attempts >= 2, "cleanup must be retried after the first simulated failure");
	await store.releaseExpired();
	assert.equal(store.getAsset(lease.assetId), undefined, "successful local or concurrent orphan cleanup must retire the in-memory deletion record");
	assert.equal(existsSync(directory), false);
});

test("a new store immediately retries a marked deletion without waiting for the absolute deadline", async () => {
	const startedAt = Date.now();
	let now = startedAt;
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("marked-recovery"), { mode: 0o600 });
	const canonicalDirectory = await realpath(directory);
	const canonical = await realpath(path);
	let failCleanup = true;
	const originalStore = new VisualEvidenceLeaseStore({
		now: () => now,
		idleTtlMs: 10_000,
		absoluteTtlMs: 30_000,
		cleanupRetryMs: 60_000,
		removeDirectory: async (target) => {
			if (target.startsWith(`${canonicalDirectory}.deleting-`) && failCleanup) throw new Error("simulated process-ending cleanup failure");
			await rm(target, { recursive: true, force: true });
		},
	});
	const lease = await originalStore.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const cleanupFailures = await originalStore.releaseAsset(lease.assetId);
	assert.equal(cleanupFailures.length, 1);
	const recoveryStore = new VisualEvidenceLeaseStore({ now: () => now });
	assert.deepEqual(await recoveryStore.sweepOrphanedAssets(), []);
	assert.equal(existsSync(cleanupFailures[0]!), false, "deletionRequestedAt must authorize immediate crash recovery before the 30-minute absolute deadline");
	failCleanup = false;
	await originalStore.releaseAll();
});

test("a new store removes expired marked snapshot directories left by a crashed process", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("orphan"), { mode: 0o600 });
	const canonical = await realpath(path);
	const crashedStore = new VisualEvidenceLeaseStore({ idleTtlMs: 1_000, absoluteTtlMs: 2_000, activeGraceMs: 1_000 });
	await crashedStore.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const markerPath = join(directory, ".pi-graph-visual-asset.json");
	const marker = JSON.parse(await readFile(markerPath, "utf8"));
	await writeFile(markerPath, JSON.stringify({ ...marker, cleanupAt: Date.now() - 1 }), { mode: 0o600 });
	const recoveryStore = new VisualEvidenceLeaseStore({ activeGraceMs: 1_000 });
	assert.deepEqual(await recoveryStore.sweepOrphanedAssets(), []);
	assert.equal(existsSync(directory), false, "the ownership marker must allow safe cleanup after restart");
	await crashedStore.releaseAll();
});

test("orphan sweeping does not use an injected lease clock to age another process's assets", async () => {
	const startedAt = Date.now();
	const directory = await createVisualTemporaryDirectory("pi-auto-vision-");
	const store = new VisualEvidenceLeaseStore({ now: () => startedAt + 31 * 60_000 });
	try {
		assert.deepEqual(await store.sweepOrphanedAssets(), []);
		assert.equal(existsSync(directory), true, "a process-local virtual lease clock must not expire shared temporary assets");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("orphan recovery preserves a live sweep quarantine without restoring over the original path", async () => {
	const startedAt = Date.now();
	const directory = await createVisualTemporaryDirectory("pi-auto-vision-", { now: () => startedAt, idleTtlMs: 10_000, absoluteTtlMs: 30_000 });
	const sweepQuarantine = `${directory}.deleting-sweep-123e4567-e89b-12d3-a456-426614174000`;
	await rename(directory, sweepQuarantine);
	const recoveryStore = new VisualEvidenceLeaseStore({ now: () => startedAt });
	assert.deepEqual(await recoveryStore.sweepOrphanedAssets(), []);
	assert.equal(existsSync(directory), false, "recovery must not use a clobbering rename to restore the original path");
	assert.equal(existsSync(sweepQuarantine), true, "a fresh marker in sweep quarantine must be preserved until its verified deadline");
	await rm(sweepQuarantine, { recursive: true, force: true });
});

test("a release quarantine is delete-only even if a crashed in-flight renewal left a future active marker", async () => {
	const startedAt = Date.now();
	const directory = await createVisualTemporaryDirectory("pi-auto-vision-", { now: () => startedAt, idleTtlMs: 10_000, absoluteTtlMs: 30_000 });
	const releaseQuarantine = `${directory}.deleting-release-123e4567-e89b-12d3-a456-426614174000`;
	await rename(directory, releaseQuarantine);
	const recoveryStore = new VisualEvidenceLeaseStore({ now: () => startedAt + 1_000 });
	assert.deepEqual(await recoveryStore.sweepOrphanedAssets(), []);
	assert.equal(existsSync(releaseQuarantine), false, "release quarantine naming must keep deletion monotonic across a crash");
});

test("a recovery store schedules orphan cleanup even when no later input arrives", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-auto-vision-"));
	const path = join(directory, "input.png");
	await writeFile(path, pngBytes("scheduled-orphan"), { mode: 0o600 });
	const canonical = await realpath(path);
	const crashedStore = new VisualEvidenceLeaseStore({ idleTtlMs: 1_000, absoluteTtlMs: 3_000 });
	await crashedStore.create({
		sessionId: "session-1", cwd: process.cwd(), originalPrompt: "inspect", paths: [canonical], sourceLabels: new Map(), directories: [directory], allowedAgents: ["interaction-designer"],
	});
	const abandoned = crashedStore as any;
	for (const timer of abandoned.assetExpiryTimers.values()) clearTimeout(timer);
	for (const timer of abandoned.leaseExpiryTimers.values()) clearTimeout(timer);
	abandoned.assetExpiryTimers.clear();
	abandoned.leaseExpiryTimers.clear();
	abandoned.assets.clear();
	abandoned.leases.clear();

	const recoveryStore = new VisualEvidenceLeaseStore();
	await recoveryStore.sweepOrphanedAssets();
	await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
	assert.equal(existsSync(directory), false, "startup recovery must arm a future cleanup timer instead of relying on another input event");
});
