import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION, createEditTool } from "@earendil-works/pi-coding-agent";
import * as sdk from "@earendil-works/pi-coding-agent";
const createAllToolDefinitions = (cwd: string) => Object.fromEntries([
	sdk.createReadToolDefinition(cwd), sdk.createBashToolDefinition(cwd), sdk.createEditToolDefinition(cwd), sdk.createWriteToolDefinition(cwd),
	sdk.createGrepToolDefinition(cwd), sdk.createFindToolDefinition(cwd), sdk.createLsToolDefinition(cwd), sdk.createPowerShellToolDefinition(cwd),
].map((tool) => [tool.name, tool]));
import { registerGuardedEditTool, registerNativeEditPolicy } from "../src/edit-guard.ts";
import { registerQuietTools, toolCallLine, toolResultLine, toolResultCard } from "../src/quiet-tools.ts";
import { navigateHostThemeSettings } from "../src/host-ui.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { memoizedLines } from "../src/render-memo.ts";

function host() {
	const native = createEditTool(process.cwd());
	const tools = new Map<string, any>(Object.entries(createAllToolDefinitions(process.cwd())));
	let active = ["read", "bash", "edit", "write"];
	const hooks = new Map<string, any>();
	const registered: string[] = [];
	const pi = {
		registerTool(tool: any) { registered.push(tool.name); tools.set(tool.name, tool); },
		on(name: string, handler: any) { hooks.set(name, handler); return () => hooks.delete(name); },
		getSettings: () => ({}),
		getAllTools: () => [...tools.values()].map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct", sourceInfo: { source: "builtin" } })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = names; },
	};
	return { pi, native, tools, hooks, registered };
}

test("native quiet decorates official definitions without the legacy edit schema", () => {
	for (const version of [VERSION, "0.99.0", "0.100.0"]) {
		const h = host();
		registerGuardedEditTool(h.pi as never, version);
		registerNativeEditPolicy(h.pi as never, version);
		assert.deepEqual(h.registered, []);
		registerQuietTools(h.pi as never, () => DEFAULT_CONFIG, version);
		assert.deepEqual(h.registered.sort(), [...h.tools.keys()].sort());
		assert.deepEqual(h.pi.getActiveTools(), ["read", "bash", "edit", "write"]);
		assert.equal("occurrence" in h.tools.get("edit").parameters.properties.edits.items.properties, false);
		assert.strictEqual(h.tools.get("edit").prepareArguments, createAllToolDefinitions(process.cwd()).edit.prepareArguments);
	}
});

test("unknown hosts leave every tool untouched", () => {
	for (const version of [null, "0.99.0-beta.1", "garbage"]) {
		const h = host();
		const originals = [...h.tools];
		registerGuardedEditTool(h.pi as never, version);
		registerNativeEditPolicy(h.pi as never, version);
		registerQuietTools(h.pi as never, () => DEFAULT_CONFIG, version);
		assert.deepEqual(h.registered, []);
		for (const [name, tool] of originals) assert.strictEqual(h.tools.get(name), tool);
	}
});

test("legacy keeps guard and quiet while native UTF8 policy does not register legacy hooks", () => {
	const h = host();
	registerNativeEditPolicy(h.pi as never, "0.98.0");
	assert.equal(h.hooks.size, 0);
	registerGuardedEditTool(h.pi as never, "0.98.0");
	registerQuietTools(h.pi as never, () => DEFAULT_CONFIG, "0.98.0");
	assert.equal(h.registered.filter((name) => name === "edit").length, 2);
	assert.equal(h.tools.get("edit").executionMode, "sequential");
});

test("UTF8 tool_call policy blocks direct and nested edit without mutating native arguments or bytes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cockpit-native-policy-"));
	try {
		const h = host();
		registerNativeEditPolicy(h.pi as never);
		const hook = h.hooks.get("tool_call");
		const bytes = Buffer.from([0x61, 0xd6, 0xd0, 0xff]);
		writeFileSync(join(dir, "gbk.txt"), bytes);
		writeFileSync(join(dir, "utf8.txt"), "中文\n");
		for (const parentToolCallId of [undefined, "parent/1"]) {
			const input = { path: "@gbk.txt", edits: [{ oldText: "a", newText: "b" }] };
			const before = structuredClone(input);
			const result = await hook({ type: "tool_call", toolName: "edit", toolCallId: parentToolCallId ? `${parentToolCallId}/1` : "direct", parentToolCallId, input }, { cwd: dir });
			assert.equal(result.block, true);
			assert.match(result.reason, /not valid UTF-8/);
			assert.deepEqual(input, before);
			assert.deepEqual(readFileSync(join(dir, "gbk.txt")), bytes);
		}
		for (const path of ["utf8.txt", "missing.txt"]) assert.equal(await hook({ toolName: "edit", input: { path } }, { cwd: dir }), undefined);
		assert.equal(await hook({ toolName: "read", input: { path: "gbk.txt" } }, { cwd: dir }), undefined);
		for (const selector of ["occurrence", "occurence"]) {
			const result = await hook({ toolName: "edit", input: { path: "utf8.txt", edits: [{ oldText: "中", newText: "文", [selector]: 1 }] } }, { cwd: dir });
			assert.equal(result.block, true);
			assert.match(result.reason, /Native edit does not support occurrence.*unique surrounding oldText/);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native theme entry only offers /settings, preserves draft and never disables auto sync", () => {
	for (const version of [VERSION, "0.100.0", "unknown"]) {
		for (const initial of ["", "unfinished user draft"]) {
			let text = initial;
			let autoSync = true;
			let themeWrites = 0;
			const ctx = { hasUI: true, ui: {
				getEditorText: () => text, setEditorText: (value: string) => { text = value; }, notify() {},
				setTheme() { autoSync = false; themeWrites++; },
			} };
			assert.equal(navigateHostThemeSettings(ctx as never, version), true);
			assert.equal(text, initial || "/settings");
			assert.equal(autoSync, true);
			assert.equal(themeWrites, 0);
			assert.equal(navigateHostThemeSettings(ctx as never, "0.98.0"), false);
		}
	}
});

test("same-key footer memo clears on invalidation and retries a failed computation", () => {
	const memo = memoizedLines();
	let palette = "old";
	const render = () => memo("same-theme-and-state", () => [palette]);
	const old = render();
	assert.strictEqual(render(), old);
	palette = "new";
	memo.clear();
	assert.deepEqual(render(), ["new"]);
	memo.clear();
	assert.throws(() => memo("same-theme-and-state", () => { throw new Error("transient"); }));
	assert.deepEqual(render(), ["new"]);
	const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
	assert.match(source, /invalidate\(\): void \{ footerMemo\.clear\(\); \}/);
	assert.match(source, /invalidate\(\): void \{ zenMemo\.clear\(\); todoWidget\.invalidate\(\); \}/);
	assert.doesNotMatch(source, /require\.resolve\("@earendil-works\/pi-tui\/package\.json"\)/);
});

test("Maestro-owned quiet UI re-reads a stable theme palette", () => {
	let color = "31";
	const theme = { fg: (_role: any, text: string) => `\x1b[${color}m${text}\x1b[0m`, bold: (text: string) => text };
	const widgets = [toolCallLine(theme, "todo"), toolResultLine(theme, { name: "todo" }), toolResultCard(theme, { name: "todo", rows: ["done"] })];
	for (const widget of widgets) assert.match(widget.render(100).join("\n"), /\x1b\[31m/);
	color = "32";
	for (const widget of widgets) {
		widget.invalidate();
		const next = widget.render(100).join("\n");
		assert.match(next, /\x1b\[32m/);
		assert.doesNotMatch(next, /\x1b\[31m/);
	}
});
