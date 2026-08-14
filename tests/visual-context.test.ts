import assert from "node:assert/strict";
import test from "node:test";
import { hasExplicitVisualReference, isVisualFollowUpPrompt, requiresFreshVisualEvidence, VisualContextStore } from "../src/subagent-router/visual-context.ts";
import type { VisualEvidenceAsset } from "../src/subagent-router/visual-evidence.ts";

function asset(overrides: Partial<VisualEvidenceAsset> = {}): VisualEvidenceAsset {
	return {
		id: "asset-1",
		sessionId: "session-1",
		cwd: process.cwd(),
		cwdRealPath: process.cwd(),
		cwdDev: 1,
		cwdIno: 1,
		originalPromptDigest: "a".repeat(64),
		createdAt: 1_000,
		lastUsedAt: 1_000,
		idleExpiresAt: 11_000,
		absoluteExpiresAt: 31_000,
		activeLeaseCount: 0,
		files: [{ path: "/tmp/image.png", sourceLabel: "image", mimeType: "image/png", sizeBytes: 1, sha256: "b".repeat(64) }],
		directories: ["/tmp/pi-auto-vision-test"],
		directoryIdentities: [{ path: "/tmp/pi-auto-vision-test", dev: 1, ino: 1 }],
		...overrides,
	};
}

test("visual follow-up detection separates continuation and fresh-pixel requests", () => {
	assert.equal(isVisualFollowUpPrompt("分组交互怪怪的，还有更好的方案吗？"), true);
	assert.equal(isVisualFollowUpPrompt("继续分析刚才那张图"), true);
	assert.equal(isVisualFollowUpPrompt("为什么这样设计？"), true);
	assert.equal(isVisualFollowUpPrompt("还有别的方案吗？"), true);
	assert.equal(isVisualFollowUpPrompt("这个方案呢？"), true);
	assert.equal(isVisualFollowUpPrompt("怎么改会更好？"), true);
	assert.equal(isVisualFollowUpPrompt("如果换成上下结构呢？"), true);
	assert.equal(isVisualFollowUpPrompt("把它放右边会不会更好？"), true);
	assert.equal(isVisualFollowUpPrompt("这种方案怎么样？"), true);
	assert.equal(isVisualFollowUpPrompt("按钮是禁用的吗？"), true);
	assert.equal(isVisualFollowUpPrompt("开关开着吗？"), true);
	assert.equal(hasExplicitVisualReference("continue with the previous screenshot"), true);
	assert.equal(hasExplicitVisualReference("刚才那张呢"), true);
	assert.equal(hasExplicitVisualReference("刚才那两张呢"), true);
	assert.equal(isVisualFollowUpPrompt("这两张有什么区别？"), true);
	assert.equal(hasExplicitVisualReference("这两张有什么区别？"), true);
	assert.equal(isVisualFollowUpPrompt("刚才那两张哪个更好？"), true);
	assert.equal(hasExplicitVisualReference("刚才那两张哪个更好？"), true);
	assert.equal(hasExplicitVisualReference("分组交互怪怪的，还有更好的方案吗？"), false);
	assert.equal(hasExplicitVisualReference("继续看刚才那个页面的代码"), false, "a page discussion must not be mistaken for a missing image");
	assert.equal(isVisualFollowUpPrompt("帮我解释今天的天气"), false);
	assert.equal(requiresFreshVisualEvidence("左边按钮是什么颜色？"), true);
	assert.equal(requiresFreshVisualEvidence("what color was the left button in the previous screenshot?"), true);
	assert.equal(requiresFreshVisualEvidence("继续完善刚才的方案"), false);
	assert.equal(requiresFreshVisualEvidence("刚才那张图上的按钮是禁用的吗？"), true);
	assert.equal(requiresFreshVisualEvidence("刚才那张图的图标是什么？"), true);
	assert.equal(requiresFreshVisualEvidence("继续比较刚才两张图"), true);
	assert.equal(requiresFreshVisualEvidence("基于刚才的文字结论继续完善方案"), false);
	assert.equal(requiresFreshVisualEvidence("按钮是禁用的吗？"), true);
	assert.equal(requiresFreshVisualEvidence("开关开着吗？"), true);
	assert.equal(requiresFreshVisualEvidence("把它放右边会不会更好？"), false);
	assert.equal(requiresFreshVisualEvidence("基于此前文字结论继续，按钮是禁用的吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案里开关开着吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案里按钮在右边吗？"), true);
	assert.equal(requiresFreshVisualEvidence("基于此前文字结论，弹窗在页面上面吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案里页面上有弹窗吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案里图标是什么形状？"), true);
	assert.equal(requiresFreshVisualEvidence("如果换成上下结构，按钮现在是禁用的吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案是否可行，当前开关开着吗？"), true);
	assert.equal(requiresFreshVisualEvidence("把它放右边会不会更好，同时页面上有弹窗吗？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案是否可行？按钮现在禁用吗？"), true);
	assert.equal(requiresFreshVisualEvidence("如果换成上下结构并且按钮现在是禁用的吗？"), true);
	assert.equal(requiresFreshVisualEvidence("还有别的方案吗？页面上有弹窗吗？"), true);
	assert.equal(requiresFreshVisualEvidence("还有别的方案吗？为什么这样设计？"), false);
	assert.equal(requiresFreshVisualEvidence("继续完善方案，同时还有别的做法吗？"), false);
	assert.equal(requiresFreshVisualEvidence("这个方案怎么样？如果换成上下结构呢？"), false);
	assert.equal(isVisualFollowUpPrompt("图标是什么形状？"), true);
	assert.equal(requiresFreshVisualEvidence("图标是什么形状？"), true);
	assert.equal(requiresFreshVisualEvidence("还有别的方案吗？按钮是什么颜色？"), true);
	assert.equal(requiresFreshVisualEvidence("还有别的方案吗？图标是什么形状？"), true);
	assert.equal(isVisualFollowUpPrompt("基于刚才那张图的文字结论继续完善方案"), true);
	assert.equal(hasExplicitVisualReference("基于刚才的文字结论继续完善方案"), true);
	assert.equal(requiresFreshVisualEvidence("基于刚才那张图的文字结论继续完善方案"), false);
	assert.equal(isVisualFollowUpPrompt("按照上一张图的文字分析继续给出建议"), true);
	assert.equal(requiresFreshVisualEvidence("按照上一张图的文字分析继续给出建议"), false);
	assert.equal(isVisualFollowUpPrompt("不用重新看图，基于上次结论继续"), true);
	assert.equal(hasExplicitVisualReference("不用重新看图，基于上次结论继续"), true);
	assert.equal(requiresFreshVisualEvidence("不用重新看图，基于上次结论继续"), false);
	assert.equal(isVisualFollowUpPrompt("把按钮改成蓝色会不会更好？"), true);
	assert.equal(requiresFreshVisualEvidence("把按钮改成蓝色会不会更好？"), false);
	assert.equal(requiresFreshVisualEvidence("按钮改成蓝色怎么样？"), false);
	assert.equal(requiresFreshVisualEvidence("把按钮放右边怎么样？"), false);
	assert.equal(requiresFreshVisualEvidence("如果换成上下结构呢，左边是什么颜色？"), true);
	assert.equal(requiresFreshVisualEvidence("把按钮改成蓝色会不会更好，同时左边是什么颜色？"), true);
	assert.equal(requiresFreshVisualEvidence("这个方案怎么样，右边是什么颜色？"), true);
	assert.equal(requiresFreshVisualEvidence("基于刚才那张图的文字结论继续完善方案，同时左边是什么颜色？"), true);
});

test("visual context reports exact reasons and counts only successful follow-ups", () => {
	let now = 1_000;
	const store = new VisualContextStore({ now: () => now, maxFollowUps: 3 });
	let currentAsset = asset();
	store.remember({ asset: currentAsset, lastAgent: "interaction-designer" });
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "分组交互呢？" }).status, "not_ready");
	store.markReady(currentAsset, "interaction-designer");
	assert.equal(store.evaluate({ sessionId: "session-2", cwd: process.cwd(), prompt: "分组交互呢？" }).status, "session_mismatch");
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "帮我看天气" }).status, "unrelated");

	for (let index = 0; index < 3; index += 1) {
		const evaluation = store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "分组交互呢？" });
		assert.equal(evaluation.status, "usable");
		store.beginFollowUp(currentAsset, "interaction-designer");
		currentAsset = { ...currentAsset, idleExpiresAt: currentAsset.idleExpiresAt + 1_000 };
		store.markReady(currentAsset, "interaction-designer");
	}
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "按钮呢？" }).status, "follow_up_limit");
	const expiredId = store.expire("follow_up_limit");
	assert.equal(expiredId, "asset-1");
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "按钮呢？" }).status, "follow_up_limit");

	now = 40_000;
	assert.equal(store.assetId(), undefined, "an expired tombstone must not retain the reusable asset id");
});

test("only a single-image visual context is eligible for automatic retention", () => {
	const store = new VisualContextStore();
	store.remember({ asset: asset(), lastAgent: "interaction-designer" });
	assert.equal(store.isSingleImage(), true);
	store.remember({
		asset: asset({ files: [asset().files[0]!, { ...asset().files[0]!, path: "/tmp/image-2.png" }] }),
		lastAgent: "interaction-designer",
	});
	assert.equal(store.isSingleImage(), false);
});

test("the three-follow-up safety ceiling cannot be relaxed by store options", () => {
	const store = new VisualContextStore({ now: () => 1_000, maxFollowUps: 99 });
	let currentAsset = asset();
	store.remember({ asset: currentAsset, lastAgent: "interaction-designer" });
	store.markReady(currentAsset, "interaction-designer");
	for (let index = 0; index < 3; index += 1) {
		assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "按钮呢？" }).status, "usable");
		store.beginFollowUp(currentAsset, "interaction-designer");
		currentAsset = { ...currentAsset, idleExpiresAt: currentAsset.idleExpiresAt + 1_000 };
		store.markReady(currentAsset, "interaction-designer");
	}
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "按钮呢？" }).status, "follow_up_limit");
});

test("visual context distinguishes idle and absolute expiry", () => {
	let now = 1_000;
	const store = new VisualContextStore({ now: () => now });
	store.remember({ asset: asset(), lastAgent: "interaction-designer" });
	store.markReady(asset(), "interaction-designer");
	now = 12_000;
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "继续看这张图" }).status, "expired_idle");
	store.discard();
	store.remember({ asset: asset({ idleExpiresAt: 50_000 }), lastAgent: "interaction-designer" });
	store.markReady(asset({ idleExpiresAt: 50_000 }), "interaction-designer");
	now = 32_000;
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "继续看这张图" }).status, "expired_absolute");
});

test("beginning a follow-up synchronizes the renewed idle deadline before queued input is evaluated", () => {
	let now = 1_000;
	const store = new VisualContextStore({ now: () => now });
	const original = asset();
	store.remember({ asset: original, lastAgent: "interaction-designer" });
	store.markReady(original, "interaction-designer");
	now = 10_999;
	const renewed = { ...original, lastUsedAt: now, idleExpiresAt: 20_999 };
	store.beginFollowUp(renewed, "interaction-designer");
	now = 12_000;
	assert.equal(store.evaluate({ sessionId: "session-1", cwd: process.cwd(), prompt: "按钮呢？" }).status, "not_ready");
});
