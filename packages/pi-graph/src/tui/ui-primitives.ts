// Local binding of the shared settings primitives for pi-graph.
// Replaces the previous cross-package `pi-graph-dashboard/src/settings/ui-primitives.ts`
// imports — the implementation now lives in pi-graph-shared-settings and is
// bound here to pi-tui's ANSI-aware width functions.

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createUiPrimitives, type UiFrameTheme } from "pi-graph-shared-settings/ui";

export type FrameTheme = UiFrameTheme;

const p = createUiPrimitives({
	measure: visibleWidth,
	clip: (text, width, ellipsis) => truncateToWidth(text, width, ellipsis),
});

export const fit = p.fit;
export const pad = p.pad;
export const rule = p.rule;
export const frame = p.frame;
export const headerLine = p.headerLine;
export const helpLine = p.helpLine;
