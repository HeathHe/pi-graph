/** Compatibility entry; locale/catalog logic is owned by pi-graph-settings. */
export * from "pi-graph-settings/v1/i18n";

/**
 * What to call the modifier that terminals deliver as Meta, on this platform.
 *
 * Every `alt+…` shortcut this product registers is delivered by the key macOS
 * labels **option** — there is no key called Alt on a Mac keyboard, so a hint
 * reading `Alt+R` sends a Mac user looking for a key that is not there. The
 * binding is unchanged and stays `alt+…`; only its name differs.
 *
 * Lives beside the locale helpers because it answers the same question they do
 * — what to show this user for a fixed underlying value — and both packages
 * that render shortcut hints already depend on this module. The axis is the
 * platform rather than the locale, so it is a separate function rather than a
 * catalog entry: the label is identical in every language.
 *
 * `⌥` is deliberately not used: U+2325 is East-Asian Ambiguous, so a terminal
 * rendering the zh-CN locale may give it two columns and break hint widths this
 * product computes.
 *
 * @param platform - platform to name the modifier for; defaults to the running one.
 * @returns `Option` on macOS, `Alt` everywhere else.
 */
export function altModifierLabel(platform: string = process.platform): string {
  return platform === "darwin" ? "Option" : "Alt";
}

/**
 * Name one `alt+…` shortcut the way this platform's keyboard labels it.
 *
 * @param key - the rest of the chord, such as `R` or `Shift+P`.
 * @param platform - platform to name it for; defaults to the running one.
 * @returns the hint text, e.g. `Option+R` on macOS and `Alt+R` elsewhere.
 */
export function altKey(key: string, platform?: string): string {
  return `${altModifierLabel(platform ?? process.platform)}+${key}`;
}
