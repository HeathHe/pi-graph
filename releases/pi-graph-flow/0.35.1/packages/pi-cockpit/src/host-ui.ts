import { VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPiFeatureOwner } from "pi-maestro-settings-core/v1";

/** No public API opens the native settings submenu. Offer the native command,
 * without executing it as an agent prompt or overwriting an existing draft.
 * In particular, never setTheme(instance): that disables host automatic sync. */
export function navigateHostThemeSettings(ctx: ExtensionContext, hostVersion: unknown = VERSION): boolean {
	if (getPiFeatureOwner(hostVersion, true) === "legacy") return false;
	if (ctx.hasUI) {
		if (ctx.ui.getEditorText() === "") ctx.ui.setEditorText("/settings");
		ctx.ui.notify("/settings → Theme (Pi owns theme selection and automatic light/dark sync)", "info");
	}
	return true;
}
