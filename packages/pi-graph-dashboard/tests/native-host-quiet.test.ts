import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
	createBashToolDefinition, createPowerShellToolDefinition, createEditToolDefinition,
	createReadToolDefinition, createWriteToolDefinition, createGrepToolDefinition,
	createFindToolDefinition, createLsToolDefinition, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
// Test-only access to the installed host, not a production integration hook.
import { ToolExecutionComponent } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
import { initTheme, setThemeInstance } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { decorateNativeQuietTool, registerQuietTools } from "../src/quiet-tools.ts";
import { DEFAULT_CONFIG, type CockpitConfig } from "../src/types.ts";

const createAllToolDefinitions = (cwd: string) => Object.fromEntries([
	createReadToolDefinition(cwd), createBashToolDefinition(cwd), createEditToolDefinition(cwd), createWriteToolDefinition(cwd),
	createGrepToolDefinition(cwd), createFindToolDefinition(cwd), createLsToolDefinition(cwd), createPowerShellToolDefinition(cwd),
].map((tool) => [tool.name, tool])) as Record<string, ToolDefinition<any, any>>;
initTheme("dark", false);
const config = (): CockpitConfig => ({ ...DEFAULT_CONFIG, enabled: true, quietMode: true, quietSymbols: "check", icons: { mode: "nerd" } });
const text = (component: ToolExecutionComponent, width = 120) => component.render(width).filter((line) => line.trim()).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
const context = (cwd: string): any => ({ cwd, model: { provider: "fixture", id: "fixture-model", input: ["text"] }, thinkingLevel: "high", sessionManager: { getSessionId: () => "fixture-session", getSessionFile: () => join(cwd, "session.jsonl") } });

function registry(settings: any = {}) {
	const cwd = process.cwd();
	const tools = new Map<string, any>(Object.entries(createAllToolDefinitions(cwd)));
	const sources = new Map([...tools.keys()].map((name) => [name, "builtin"]));
	let active = ["read", "bash", "edit", "write", "custom"];
	const registered: string[] = [];
	const pi = {
		getSettings: () => settings,
		getAllTools: () => [...tools.values()].map((tool) => ({ ...tool, exposure: tool.exposure ?? "direct", sourceInfo: { source: sources.get(tool.name) } })),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => { active = names; },
		registerTool(tool: any) { tools.set(tool.name, tool); registered.push(tool.name); active.push(tool.name); },
	};
	return { pi, tools, sources, registered };
}

test("native decoration preserves every official non-render field by identity", () => {
	for (const original of Object.values(createAllToolDefinitions(process.cwd()))) {
		const decorated = decorateNativeQuietTool(original, config);
		for (const key of Reflect.ownKeys(original)) {
			if (["renderCall", "renderResult", "renderShell"].includes(String(key))) continue;
			assert.strictEqual((decorated as any)[key], (original as any)[key], `${original.name}.${String(key)}`);
		}
		assert.equal(decorated.renderShell, "self");
	}
	const original = { ...createBashToolDefinition(process.cwd()), exposure: "model-only", namespace: { name: "native" }, annotations: { readOnlyHint: true }, defaultActive: false, executionMode: "parallel", prepareLoadout: () => undefined } as ToolDefinition<any, any>;
	const decorated = decorateNativeQuietTool(original, config);
	for (const key of ["outputSchema", "constrainedSampling", "promptGuidelines", "promptSnippet", "exposure", "namespace", "annotations", "defaultActive", "executionMode", "prepareLoadout", "execute"]) assert.strictEqual((decorated as any)[key], (original as any)[key]);
});

test("registration skips third-party and distinguishable base overrides, never activates extra tools", () => {
	const r = registry();
	const foreign = { ...r.tools.get("read"), execute: () => { throw new Error("foreign"); } };
	r.tools.set("read", foreign);
	r.sources.set("read", "extension");
	const customBase = { ...r.tools.get("bash"), description: "Custom SDK bash" };
	r.tools.set("bash", customBase);
	const custom = { name: "custom", execute: () => "custom" };
	r.tools.set("custom", custom); r.sources.set("custom", "sdk");
	const active = r.pi.getActiveTools();
	assert.equal(registerQuietTools(r.pi as never, config, "0.99.0"), true);
	assert.strictEqual(r.tools.get("read"), foreign);
	assert.strictEqual(r.tools.get("bash"), customBase);
	assert.strictEqual(r.tools.get("custom"), custom);
	assert.deepEqual(r.pi.getActiveTools(), active);
	assert.deepEqual(r.registered.sort(), ["edit", "write", "grep", "find", "ls", "powershell"].sort());
});

test("native registration reports unavailable when all tools have foreign owners", () => {
	const r = registry();
	for (const name of r.sources.keys()) r.sources.set(name, "extension");
	const active = r.pi.getActiveTools();
	assert.equal(registerQuietTools(r.pi as never, config, "0.99.0"), false);
	assert.deepEqual(r.registered, []);
	assert.deepEqual(r.pi.getActiveTools(), active);
});

test("native shell output cannot override canonical successful status", () => {
	for (const original of [createBashToolDefinition(process.cwd()), createPowerShellToolDefinition(process.cwd())]) {
		const component = new ToolExecutionComponent(original.name, "printed-status", { command: "echo status" }, { showImages: false }, decorateNativeQuietTool(original, config), { requestRender() {} } as never, process.cwd());
		for (const output of ["Command exited with code 7", "exit code: 7"]) {
			component.updateResult({ content: [{ type: "text", text: output }], isError: false });
			assert.match(text(component), new RegExp(`✓ ${original.name} `));
			assert.match(text(component), /· 0 · 1L/);
		}
	}
});

test("active tool snapshot is restored even when registration throws", () => {
	const r = registry();
	const active = r.pi.getActiveTools();
	const original = r.pi.registerTool;
	r.pi.registerTool = (tool) => { original(tool); throw new Error("host registration failure"); };
	assert.throws(() => registerQuietTools(r.pi as never, config, "0.99.0"), /host registration failure/);
	assert.deepEqual(r.pi.getActiveTools(), active);
});

test("actual host call, partial, final, errors and expansion lifecycle stays compact for all eight tools", () => {
	const args: Record<string, any> = { read: { path: "file.ts" }, bash: { command: "echo ok" }, powershell: { command: "Write-Output ok" }, edit: { path: "file.ts", edits: [{ oldText: "old", newText: "new" }] }, write: { path: "file.ts", content: "one\ntwo" }, grep: { pattern: "ok", path: "." }, find: { pattern: "*.ts", path: "." }, ls: { path: "." } };
	for (const original of Object.values(createAllToolDefinitions(process.cwd()))) {
		const component = new ToolExecutionComponent(original.name, `call-${original.name}`, {}, { showImages: false }, decorateNativeQuietTool(original, config), { requestRender() {} } as never, process.cwd());
		component.updateArgs(args[original.name]);
		component.setArgsComplete();
		component.markExecutionStarted();
		assert.match(text(component), new RegExp(`… ${original.name} `));
		component.updateResult({ content: [{ type: "text", text: "streamed output" }], isError: false }, true);
		assert.equal(text(component).split("\n").length, 1, "partial output must not duplicate the call row");
		component.updateResult({ content: [{ type: "text", text: "first\nsecond" }], isError: false, details: original.name === "edit" ? { diff: "-old\n+new" } : undefined });
		assert.equal(text(component).split("\n").length, 1);
		assert.match(text(component), new RegExp(`✓ ${original.name} `));
		if (["bash", "powershell"].includes(original.name)) assert.match(text(component), /· 0 · 2L/);
		component.setExpanded(true);
		assert.match(text(component), original.name === "edit" ? /-old\n\+new/ : /first\nsecond/);
		component.setExpanded(false);
		// ToolExecutionComponent strips result.isError before calling renderResult;
		// the canonical error flag must therefore come from its render context.
		component.updateResult({ content: [{ type: "text", text: "spawn failed" }], isError: true });
		assert.match(text(component), new RegExp(`✕ ${original.name} `));
		if (["bash", "powershell"].includes(original.name)) assert.match(text(component), /· \? · 1L/);
		component.updateResult({ content: [{ type: "text", text: "failure\nCommand exited with code 7" }], isError: true });
		assert.match(text(component), new RegExp(`✕ ${original.name} `));
		if (["bash", "powershell"].includes(original.name)) assert.match(text(component), /· 7 · 2L/);
		for (let width = 1; width <= 120; width++) {
			for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${original.name}: ${width}: ${line}`);
		}
	}
});

test("native host supports live symbols, icon mode, quiet/enabled toggles and stable palette invalidation", () => {
	let current = config();
	let palette = "31";
	const paint: any = { fg: (_role: string, value: string) => `\x1b[${palette}m${value}\x1b[0m`, bg: (_role: string, value: string) => value, bold: (value: string) => value };
	setThemeInstance(paint);
	try {
		const original = createReadToolDefinition(process.cwd());
		const decorated = decorateNativeQuietTool(original, () => current);
		const host = new ToolExecutionComponent("read", "live", { path: "file.ts" }, { showImages: false }, decorated, { requestRender() {} } as never, process.cwd());
		host.updateResult({ content: [{ type: "text", text: "official output" }], isError: false });
		assert.match(host.render(100).join("\n"), /\x1b\[31m/);
		palette = "32"; host.invalidate();
		assert.match(host.render(100).join("\n"), /\x1b\[32m/);
		assert.doesNotMatch(host.render(100).join("\n"), /\x1b\[31m/);
		current = { ...current, quietSymbols: "dot" };
		assert.match(text(host), /● read/);
		current = { ...current, icons: { mode: "ascii" } };
		assert.match(text(host), /\* read/);
		current = { ...current, quietMode: false };
		const official = new ToolExecutionComponent("read", "live", { path: "file.ts" }, { showImages: false }, original, { requestRender() {} } as never, process.cwd());
		official.updateResult({ content: [{ type: "text", text: "official output" }], isError: false });
		assert.deepEqual(host.render(100), official.render(100), "quiet off restores the original official shell and content");
		current = { ...current, quietMode: true, enabled: false };
		assert.deepEqual(host.render(100), official.render(100));
		current = { ...current, enabled: true };
		assert.match(text(host), /\* read/);
	} finally { initTheme("dark", false); }
});

test("quiet off and Cockpit disabled restore official shell composition for all eight tools", () => {
	for (const original of Object.values(createAllToolDefinitions(process.cwd()))) {
		let current = config();
		const args = { path: "file.txt", command: "echo ok", pattern: "ok", content: "one\ntwo", edits: [{ oldText: "old", newText: "new" }] };
		const decorated = new ToolExecutionComponent(original.name, "shell", args, { showImages: false }, decorateNativeQuietTool(original, () => current), { requestRender() {} } as never, process.cwd());
		const official = new ToolExecutionComponent(original.name, "shell", args, { showImages: false }, original, { requestRender() {} } as never, process.cwd());
		const result = { content: [{ type: "text", text: "official output" }], isError: false, details: original.name === "edit" ? { diff: "-old\n+new" } : undefined };
		decorated.updateResult(result); official.updateResult(result);
		current = { ...current, quietMode: false };
		assert.deepEqual(decorated.render(100), official.render(100), original.name);
		current = { ...current, quietMode: true, enabled: false };
		assert.deepEqual(decorated.render(100), official.render(100), `${original.name}: disabled`);
		current = { ...current, enabled: true };
		assert.equal(text(decorated).split("\n").length, 1, original.name);
	}
});

test("native shell renderer state and timer cleanup survive a quiet toggle during streaming", () => {
	let current = { ...config(), quietMode: false };
	const original = createBashToolDefinition(process.cwd());
	const decorated = decorateNativeQuietTool(original, () => current);
	const state: any = {};
	const ctx: any = { args: { command: "echo ok" }, state, executionStarted: true, isPartial: true, invalidate() {}, showImages: false };
	const paint: any = { fg: (_role: string, value: string) => value, bold: (value: string) => value };
	decorated.renderCall!(ctx.args, paint, ctx);
	decorated.renderResult!({ content: [{ type: "text", text: "stream" }], details: undefined }, { expanded: false, isPartial: true }, paint, ctx);
	assert.ok(state.interval);
	current = { ...current, quietMode: true };
	decorated.renderResult!({ content: [{ type: "text", text: "done" }], details: undefined }, { expanded: false, isPartial: false }, paint, { ...ctx, isPartial: false });
	assert.equal(state.interval, undefined);
});

test("official native execution retains fifth context, prefix, session env, updates, timeout and nonzero structured output", async () => {
	for (const factory of [createBashToolDefinition, createPowerShellToolDefinition]) {
		let spawn: any;
		const signal = new AbortController().signal;
		const updates: any[] = [];
		const original = factory("unused-cwd", { commandPrefix: "setup", operations: { async exec(command, cwd, options) { spawn = { command, cwd, options }; options.onData(Buffer.from("hello\n")); return { exitCode: 7 }; } } });
		const tool = decorateNativeQuietTool(original, config);
		const ctx = context(process.cwd());
		const result = await tool.execute("execution", { command: "run", timeout: 9 }, signal, (update) => updates.push(update), ctx);
		assert.strictEqual(tool.execute, original.execute);
		assert.equal(spawn.command, "setup\nrun");
		assert.equal(spawn.cwd, ctx.cwd);
		assert.equal(spawn.options.timeout, 9);
		assert.strictEqual(spawn.options.signal, signal);
		assert.equal(spawn.options.env.PI_SESSION_ID, "fixture-session");
		assert.equal(spawn.options.env.PI_MODEL, "fixture-model");
		assert.equal(spawn.options.env.PI_PROVIDER, "fixture");
		assert.equal(spawn.options.env.PI_REASONING_LEVEL, "high");
		assert.equal(spawn.options.env.PI_SESSION_FILE, join(ctx.cwd, "session.jsonl"));
		assert.ok(updates.length >= 2);
		assert.equal(result.isError, true);
		assert.equal((result.structuredContent as any).exit_code, 7);
		assert.equal((result.structuredContent as any).output, "hello\n");
	}
	const aborted = decorateNativeQuietTool(createBashToolDefinition(".", { operations: { async exec() { throw new Error("aborted"); } } }), config);
	await assert.rejects(() => aborted.execute("abort", { command: "run" }, undefined, undefined, context(process.cwd())), /Command aborted/);
});

// A small valid 2x2 PNG, generated without an external imaging dependency.
function png() {
	const chunk = (type: string, data: Buffer) => {
		const payload = Buffer.concat([Buffer.from(type), data]);
		let crc = 0xffffffff;
		for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
		const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
		const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
		return Buffer.concat([size, payload, checksum]);
	};
	const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, ...Array(8).fill(255), 0, ...Array(8).fill(255)]))), chunk("IEND", Buffer.alloc(0))]);
}

test("registration honors image settings, current model resize limits, cwd and native multi-edit semantics", async () => {
	const dir = mkdtempSync(join(tmpdir(), "cockpit-native-quiet-"));
	try {
		writeFileSync(join(dir, "image.png"), png());
		writeFileSync(join(dir, "file.txt"), "first\nsecond\n");
		const ctx = context(dir);
		ctx.model.inputLimits = { images: { resize: { maxWidth: 1, maxHeight: 1 } } };
		for (const autoResize of [false, true]) {
			const r = registry({ images: { autoResize } });
			registerQuietTools(r.pi as never, config, "0.99.0", "unused-cwd");
			const image = await r.tools.get("read").execute("image", { path: "image.png" }, undefined, undefined, ctx);
			assert.match(image.content[0].text, /Current model does not support images/);
			assert.equal(image.content[1].type, "image");
			if (autoResize) assert.match(image.content[0].text, /1x1/);
			else assert.equal(image.content[1].data, png().toString("base64"));
			const read = await r.tools.get("read").execute("read", { path: "file.txt" }, undefined, undefined, ctx);
			assert.equal(read.content[0].text, "first\nsecond\n");
			await r.tools.get("edit").execute("edit", { path: "file.txt", edits: [{ oldText: "first", newText: "FIRST" }, { oldText: "second", newText: "SECOND" }] }, undefined, undefined, ctx);
			assert.equal(readFileSync(join(dir, "file.txt"), "utf8"), "FIRST\nSECOND\n");
			writeFileSync(join(dir, "file.txt"), "first\nsecond\n");
			await r.tools.get("write").execute("write", { path: "new.txt", content: "native write" }, undefined, undefined, ctx);
			assert.equal(readFileSync(join(dir, "new.txt"), "utf8"), "native write");
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("registered native bash honors settings command prefix and explicit shell path", async () => {
	const r = registry({ shellCommandPrefix: "export COCKPIT_PREFIX=from-settings" });
	registerQuietTools(r.pi as never, config, "0.99.0");
	const result = await r.tools.get("bash").execute("prefix", { command: 'printf "%s|%s" "$COCKPIT_PREFIX" "$PI_SESSION_ID"' }, undefined, undefined, context(process.cwd()));
	assert.equal(result.content[0].text, "from-settings|fixture-session");
	const invalid = join(process.cwd(), "nonexistent-cockpit-shell");
	const bad = registry({ shellPath: invalid });
	registerQuietTools(bad.pi as never, config, "0.99.0");
	await assert.rejects(() => bad.tools.get("bash").execute("shell", { command: "echo ok" }, undefined, undefined, context(process.cwd())), /nonexistent-cockpit-shell/);
});
