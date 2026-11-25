import assert from "node:assert/strict";
import test from "node:test";
import { resolveGlyphs } from "../src/ui/icons.ts";
import { openOverlay, openOverlayLegacy, type HostComponent, type OverlayHostDeps, type OverlayUI } from "../src/ui/overlay-host.ts";
import { line } from "../src/ui/overlay-spec.ts";

const theme = { fg: (_name: string, text: string) => text };
const keys = { matches: (data: string, name: string) => data === name };
const deps: OverlayHostDeps = {
	utils: { measure: (text) => text.length, clip: (text, width) => text.slice(0, width) },
	glyphs: resolveGlyphs("ascii"),
	matchesKey: (data, name) => data === name,
	termRows: 10,
};

async function captureResult<T>(mount: (done: (result: T) => void) => Promise<void>): Promise<T> {
	let result: { value: T } | undefined;
	await mount((value) => { result = { value }; });
	assert.ok(result, "overlay must close via done()");
	return result.value;
}

test("mounted overlays forward host invalidation and close normally", async () => {
	let state = "initial";
	let disposed = false;
	const ui: OverlayUI = {
		async custom(factory, options) {
			assert.equal(options?.overlay, true);
			return captureResult(async (done) => {
				const component = await factory({ requestRender() {} }, theme, keys, done);
				assert.match(component.render(24).join("\n"), /initial/);
				component.invalidate();
				assert.match(component.render(24).join("\n"), /updated/);
				component.handleInput?.("enter");
				component.dispose?.();
			});
		},
	};
	assert.equal(await openOverlay({ ui }, { kind: "card" }, {
		render: () => [line(state)],
		invalidate: () => { state = "updated"; },
		handleKey: (input) => input === "enter" ? "close" : false,
		closeResult: "accepted",
		dispose: () => { disposed = true; },
	}, deps), "accepted");
	assert.equal(disposed, true);
});

test("legacy overlay factories may omit invalidate and still receive input, focus, and disposal", async () => {
	for (const asyncFactory of [false, true]) {
		let disposed = false;
		let input = "";
		const component: HostComponent = {
			focused: false,
			render() { return [`${this.focused ? "focused" : "blurred"}: ${input}`]; },
			handleInput(value) { assert.equal(this, component); input = value; },
			dispose() { assert.equal(this, component); disposed = true; },
		};
		let close: (() => void) | undefined;
		const ui: OverlayUI = {
			async custom(factory) {
				return captureResult(async (done) => {
					const mounted = factory({ requestRender() {} }, theme, keys, done);
					assert.equal(mounted instanceof Promise, asyncFactory);
					const overlay = await mounted;
					overlay.invalidate();
					overlay.focused = true;
					overlay.handleInput?.("hello");
					assert.deepEqual(overlay.render(24), ["focused: hello"]);
					overlay.dispose?.();
					close?.();
				});
			},
		};
		assert.equal(await openOverlayLegacy<string>({ ui }, (_tui, _theme, _keys, done) => {
			close = () => done("complete");
			return asyncFactory ? Promise.resolve(component) : component;
		}), "complete");
		assert.equal(disposed, true);
		assert.equal("invalidate" in component, false);
	}
});
