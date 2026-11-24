//! `theme` — Devin dark/light CSS variable theme → blitz-dom UA stylesheet.
//!
//! Recovered verbatim from `devin-re/SCROLLBACK-RECON.md` §12.1 (full CSS
//! dump at `.rdata` 0x736a788..0x736d3d6, ~11KB with comments). The
//! stylesheet is injected as a user-agent sheet so component `class`
//! attributes resolve through stylo; `var(--x)` is resolved by stylo's
//! custom-property machinery.
//!
//! Root `color: transparent` maps to `Color::Reset` (terminal-native fg) in
//! `scrollback::cell_render` — matching the original's convention.

use scrollback::{CellStyle, Color, Modifier};

/// Which theme variant is active.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeKind {
    Dark,
    Light,
    Nord,
    SolarizedDark,
    SolarizedLight,
    HighContrast,
}

impl ThemeKind {
    /// Every theme, in picker order.
    pub const ALL: &'static [ThemeKind] = &[
        ThemeKind::Dark,
        ThemeKind::Light,
        ThemeKind::Nord,
        ThemeKind::SolarizedDark,
        ThemeKind::SolarizedLight,
        ThemeKind::HighContrast,
    ];

    /// Stable lowercase name (`--theme`, `PI_TUI_THEME`, `/theme`).
    pub fn name(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::Nord => "nord",
            Self::SolarizedDark => "solarized-dark",
            Self::SolarizedLight => "solarized-light",
            Self::HighContrast => "high-contrast",
        }
    }

    /// Parse a theme name; accepts a few friendly aliases.
    pub fn from_name(s: &str) -> Option<ThemeKind> {
        match s.trim().to_lowercase().as_str() {
            "dark" => Some(ThemeKind::Dark),
            "light" => Some(ThemeKind::Light),
            "nord" => Some(ThemeKind::Nord),
            "solarized-dark" | "solarized" | "solarized_dark" | "sdark" => {
                Some(ThemeKind::SolarizedDark)
            }
            "solarized-light" | "solarized_light" | "slight" => Some(ThemeKind::SolarizedLight),
            "high-contrast" | "highcontrast" | "hc" => Some(ThemeKind::HighContrast),
            _ => None,
        }
    }

    /// Short picker description (flavor, not a restatement of the name).
    pub fn description(self) -> &'static str {
        match self {
            Self::Dark => "fluent dark (default)",
            Self::Light => "fluent light",
            Self::Nord => "polar blue",
            Self::SolarizedDark => "precision teal",
            Self::SolarizedLight => "paper",
            Self::HighContrast => "max legibility",
        }
    }

    /// The blitz-dom `ColorScheme` for the viewport.
    pub fn color_scheme(self) -> blitz_traits::shell::ColorScheme {
        match self {
            Self::Dark | Self::Nord | Self::SolarizedDark | Self::HighContrast => {
                blitz_traits::shell::ColorScheme::Dark
            }
            Self::Light | Self::SolarizedLight => blitz_traits::shell::ColorScheme::Light,
        }
    }
}

/// Detect the theme from the environment.
///
/// `PI_TUI_THEME=<name>` wins (any `ThemeKind::from_name` value); otherwise
/// `COLORFGBG` (a light terminal background ends with a light fg color
/// index like `0;15`/`15`) decides; default dark.
pub fn detect() -> ThemeKind {
    if let Ok(v) = std::env::var("PI_TUI_THEME") {
        if let Some(kind) = ThemeKind::from_name(&v) {
            return kind;
        }
    }
    if let Ok(v) = std::env::var("COLORFGBG") {
        if let Some(last) = v.rsplit(';').next() {
            if let Ok(bg) = last.trim().parse::<u8>() {
                // Light backgrounds: 7, 15, or bright colors.
                if matches!(bg, 7 | 15) || bg >= 8 && bg != 8 {
                    return ThemeKind::Light;
                }
            }
        }
    }
    ThemeKind::Dark
}

/// The UA stylesheet for the given theme.
///
/// Layout contract (1 CSS px = 1 terminal cell):
/// `font-size:1px; line-height:1px` + the embedded TerminalMono font whose
/// advance == unitsPerEm (1000) make every character exactly 1 cell wide.
/// `white-space:pre-wrap` preserves newlines and wraps at the content edge.
///
/// The variable block + utility classes are verbatim from the original
/// (RECON §12.1); the `#app`/component section is our app shell.
pub fn stylesheet(kind: ThemeKind) -> String {
    let v = Vars::for_kind(kind);
    // `.theme-light` overrides are emitted as a flat block when kind==Light
    // (blitz-dom has no .theme-light class toggle — we bake the variant).
    let agent_css: String = v
        .agent_colors
        .iter()
        .enumerate()
        .map(|(i, c)| format!(".agent-color-{i} {{ color: {c}; border-left: 1px solid {c}; }}\n"))
        .collect();
    format!(
        r#"
:root {{
    --text-primary: {text_primary};
    --text-secondary: {text_secondary};
    --text-muted: {text_muted};
    --accent-primary: {accent_primary};
    --accent-secondary: {accent_secondary};
    --fusion-lead: {fusion_lead};
    --fusion-sidekick: {fusion_sidekick};
    --fusion-highlight: {fusion_highlight};
    --status-success: {status_success};
    --status-warning: {status_warning};
    --status-error: {status_error};
    --status-info: {status_info};
    --surface-base: transparent;
    --surface-elevated: {surface_elevated};
    --surface-dropdown: {surface_dropdown};
    --surface-dropdown-selected: {surface_dropdown_selected};
    --surface-overlay: {surface_overlay};
    --text-inverted: {text_inverted};
    --border-default: {border_default};
    --selection-indicator: {selection_indicator};
    --surface-accent: {surface_accent};
    --text-on-surface-accent: {text_on_surface_accent};
    --link-color: {link_color};
    --link-hover: {link_hover};
    --code-block-bg: {code_block_bg};
    --code-inline-bg: {code_inline_bg};
    --tool-cmd: {tool_cmd};
    --diff-insert-bg: {diff_insert_bg};
    --diff-delete-bg: {diff_delete_bg};
    --diff-emphasis-insert-bg: {diff_emphasis_insert_bg};
    --diff-emphasis-delete-bg: {diff_emphasis_delete_bg};
    color: transparent;
}}

html, body {{
    width: 100%;
    margin: 0;
    padding: 0;
    font-family: "TerminalMono", monospace;
    font-size: 1px;
    line-height: 1px;
    white-space: pre-wrap;
    word-wrap: break-word;
    font-kerning: none;
    font-variant-ligatures: none;
    font-feature-settings: "kern" 0, "liga" 0, "clig" 0;
    letter-spacing: 0;
    background: var(--surface-base);
    color: transparent;
}}

main {{ display: block; }}
body > main {{ width: 100%; }}

div, p, pre, ul, ol, li, header, footer, section, article, nav,
textarea, span, a, strong, b, em, i, code, h1, h2, h3, h4, h5, h6 {{
    display: block;
    line-height: 1px;
}}
span, a, strong, b, em, i, code {{
    display: inline;
    line-height: 1px;
}}
h1, h2, h3, h4, h5, h6, p, ul, ol, li {{ margin: 0; padding: 0; }}
li p {{ display: inline; }}
h1, h2, h3, h4, h5, h6 {{ font-size: 1em; }}
a {{ color: var(--link-color); text-decoration: underline; word-wrap: break-word; }}
strong, b {{ font-weight: bold; }}
em, i {{ font-style: italic; }}
s, del {{ text-decoration: line-through; }}
code, pre {{ font-family: monospace; background: var(--surface-elevated); color: var(--text-primary); padding: 0; word-wrap: break-word; }}
pre {{ white-space: pre-wrap; }}
hr {{ display: block; width: 100%; height: 1px; margin: 0; padding: 0; border: none; color: var(--border-default); }}
img {{ display: block; }}
ul, ol {{ margin: 0; padding-left: 2px; }}
button, input, select, textarea {{ background: var(--surface-elevated); color: var(--text-primary); border: none; padding: 0; }}
button:focus, input:focus, select:focus, textarea:focus {{ outline: none; background: var(--surface-overlay); color: var(--accent-primary); }}

/* Utility classes */
.text-secondary {{ color: var(--text-secondary); }}
.text-muted {{ color: var(--text-muted); }}
.text-accent {{ color: var(--accent-primary); }}
.text-success {{ color: var(--status-success); }}
.text-warning {{ color: var(--status-warning); }}
.text-error {{ color: var(--status-error); }}
.text-info {{ color: var(--status-info); }}
.text-selection {{ color: var(--selection-indicator); }}
.text-border {{ color: var(--border-default); }}
.color-muted {{ color: var(--text-muted); }}

.text-heading-h1 {{ color: {heading_h1}; }}

.bg-code-block {{
    background: var(--code-block-bg);
    color: var(--text-primary);
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--accent-primary);
    padding-left: 1px;
    padding-top: 1px;
    padding-bottom: 1px;
}}
.bg-code-inline {{ background: var(--code-inline-bg); }}
.bg-base {{ background: var(--surface-base); }}
.bg-elevated {{ background: var(--surface-elevated); color: var(--text-primary); }}
.bg-overlay {{ background: var(--surface-overlay); color: var(--text-primary); }}

/* Inverted highlight (active tab, selected attachment). */
.inverted {{ background: var(--text-muted); color: var(--text-inverted); }}

/* Diff line backgrounds (lighter) */
.diff-line-context {{ background: var(--surface-elevated); color: var(--text-primary); }}
.diff-line-insert {{ background: {diff_insert_bg}; color: var(--text-primary); }}
.diff-line-delete {{ background: {diff_delete_bg}; color: var(--text-primary); }}
/* Diff emphasis backgrounds (stronger, for changed segments) */
.diff-emphasis-insert {{ background: {diff_emphasis_insert_bg}; color: var(--text-primary); }}
.diff-emphasis-delete {{ background: {diff_emphasis_delete_bg}; color: var(--text-primary); }}

/* User message background — flat fill, no border (RECON §12.1). */
.user-message {{ background: {user_message_bg}; color: var(--text-primary); }}

/* Syntax highlighting */
.syntax-keyword {{ color: {syn_keyword}; }}
.syntax-string {{ color: {syn_string}; }}
.syntax-comment {{ color: {syn_comment}; }}
.syntax-function {{ color: {syn_function}; }}
.syntax-type {{ color: {syn_type}; }}
.syntax-number {{ color: {syn_number}; }}
.syntax-constant {{ color: {syn_constant}; }}
.syntax-operator {{ color: var(--text-primary); }}
.syntax-variable-builtin {{ color: {syn_var_builtin}; }}
.syntax-attribute {{ color: {syn_var_builtin}; }}
.syntax-property {{ color: {syn_var_builtin}; }}

/* Hide tips on narrow terminals */
.tip-text {{ display: inline; }}
@media (max-width: 79px) {{
    .tip-text {{ display: none; }}
}}

/* Tables render as pre-formatted monospace lines (`│ a │ b │`) —
   taffy has no `display: table`, so markdown.rs emits aligned text. */
.md-table {{
    display: flex;
    flex-direction: column;
    margin-top: 1px;
    margin-bottom: 1px;
}}
.md-tr {{ display: flex; flex-direction: row; color: var(--text-secondary); }}
.md-th {{ color: var(--text-primary); font-weight: bold; }}
.md-sep, .md-border {{ color: var(--border-default); }}

/* Math: `$…$` inline, `$$…$$` display block (raw TeX, accent color). */
.md-math {{ color: var(--accent-primary); }}
.md-math-display {{
    padding-left: 2px;
    margin-top: 1px;
    margin-bottom: 1px;
}}

.model-picker {{
    --model-picker-wide-display: flex;
    --model-picker-narrow-display: none;
    --model-picker-pricing-margin-top: 1px;
}}
.model-picker .select-inline-hint {{ display: none; }}
@media (max-width: 99px) {{
    .model-picker {{
        --model-picker-wide-display: none;
        --model-picker-narrow-display: flex;
        --model-picker-pricing-margin-top: 0px;
    }}
    .model-picker .select-desc {{ display: none; }}
}}

/* ============================ app shell ============================ */

#app {{
    display: flex;
    flex-direction: column;
    overflow: hidden;
}}

.messages-wrap {{
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0px;
    overflow: hidden;
    display: flex;
    flex-direction: row;
}}

#messages {{
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    padding-top: 1px;
}}

#scrollbar {{
    width: 1px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
}}

.scrollbar-thumb {{
    width: 1px;
    background: var(--border-default);
}}

/* Thinking-trace overlay (F3): replaces #messages-wrap in-flow. */
#trace {{
    display: none;
    flex-grow: 1;
    flex-shrink: 1;
    flex-basis: 0px;
    overflow: hidden;
    color: var(--text-muted);
    font-style: italic;
    padding-left: 1px;
    padding-top: 1px;
    white-space: pre-wrap;
}}

/* Scrollback search (Ctrl+S) marks — render-only, no text mutation. */
.msg-search-hit {{
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--status-warning);
}}

.msg-search-current {{
    background: var(--surface-overlay);
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--accent-primary);
}}

.msg {{
    margin-bottom: 1px;
    padding-left: 1px;
    padding-right: 1px;
    flex-shrink: 0;
}}

.msg-user {{
    align-self: stretch;
    background: {user_message_bg};
    color: var(--text-primary);
    padding-top: 1px;
    padding-bottom: 1px;
}}

.msg-assistant {{
    align-self: stretch;
    color: var(--text-primary);
}}

.msg-thinking {{
    align-self: stretch;
    color: var(--text-muted);
    font-style: italic;
}}

.msg-tool {{
    align-self: stretch;
    color: var(--text-muted);
}}

.msg-error {{
    align-self: stretch;
    color: var(--status-error);
}}

.msg-system {{
    align-self: stretch;
    color: var(--text-muted);
}}

/* Nested tool card of a backgrounded subagent (Devin subagent/mode). */
.msg-hidden {{ display: none; }}

.tool-glyph {{ color: var(--accent-primary); }}
.tool-glyph-ok {{ color: var(--status-success); }}
.tool-glyph-err {{ color: var(--status-error); }}
.tool-glyph-run {{ color: var(--status-warning); }}

#input-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    border-top: 1px solid var(--border-default);
    /* Bottom rule closes the input box — pickers/completion render
       below it (native pi layout). */
    border-bottom: 1px solid var(--border-default);
}}

#input-hint {{
    color: var(--text-muted);
    padding-left: 1px;
}}

#input-box {{
    display: flex;
    flex-direction: row;
    padding-left: 1px;
    padding-right: 1px;
    max-height: 8px;
    overflow: hidden;
}}

#input-prompt {{
    color: var(--accent-primary);
    font-weight: bold;
    flex-shrink: 0;
    width: 2px;
}}

#input-text {{
    flex-grow: 1;
    color: var(--text-primary);
}}

#completion-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}}
.completion-item {{
    display: flex;
    flex-direction: row;
    color: var(--text-primary);
    padding-left: 1px;
}}
.completion-item.selected {{
    background-color: var(--surface-accent);
    color: var(--text-on-surface-accent);
}}
.completion-marker {{ color: var(--accent-primary); flex-shrink: 0; }}
.completion-label {{ color: var(--text-primary); flex-shrink: 0; }}
.completion-desc {{ color: var(--text-muted); }}
.completion-more {{ color: var(--text-muted); padding-left: 2px; }}
.queued-line {{ color: var(--text-muted); padding-left: 1px; }}

#status-line {{
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    color: var(--text-muted);
    padding-left: 1px;
    padding-right: 1px;
    overflow: hidden;
}}

#status-left {{
    display: flex;
    flex-direction: row;
    min-width: 0px;
    overflow: hidden;
}}
#status-left span {{ flex-shrink: 0; }}

#status-right {{
    margin-left: auto;
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    color: var(--text-muted);
}}

.status-model {{ color: var(--text-secondary); font-weight: bold; }}
.status-permission {{ color: var(--text-muted); }}
.status-thinking {{ color: var(--accent-secondary); }}
.status-mode {{ color: var(--text-secondary); }}
.status-cwd {{ color: var(--text-muted); }}
.status-git {{ color: var(--accent-secondary); }}
.status-running {{ color: var(--accent-primary); font-weight: bold; }}
.status-queue, .status-transient {{ color: var(--status-warning); }}
.status-bg {{ color: var(--status-info); }}
.status-ssh {{ color: var(--accent-secondary); }}
.status-accent {{ color: var(--accent-primary); }}
.status-info {{ color: var(--status-info); }}
.status-ok {{ color: var(--status-success); }}
.status-warn {{ color: var(--status-warning); }}
.status-err {{ color: var(--status-error); }}

/* Right resource group (cockpit): ctx meter, in/out tokens, cost. */
.status-ctx-ok {{ color: var(--accent-primary); }}
.status-ctx-warn {{ color: var(--status-warning); }}
.status-ctx-crit {{ color: var(--status-error); }}
.status-tok-in {{ color: var(--accent-primary); }}
.status-tok-out {{ color: var(--status-success); }}
.status-cost {{ color: var(--status-warning); }}

/* Mid-width: drop low-priority context (path/git) before actionable
   segments get clipped — same fallback ladder as the cockpit footer. */
@media (max-width: 119px) {{
    .status-cwd, .status-git {{ display: none; }}
}}
@media (max-width: 79px) {{
    .status-thinking, .status-mode, #status-right {{ display: none; }}
}}
@media (max-width: 39px) {{
    .status-model {{ display: none; }}
}}

/* ---------- markdown ---------- */

.text-accent {{ color: var(--accent-primary); }}
.md-p {{ margin-bottom: 1px; }}
.md-h {{
    font-weight: bold;
    margin-top: 2px;
    margin-bottom: 1px;
}}
.text-heading-h1 {{ margin-top: 2px; margin-bottom: 2px; }}
.md-h2 {{
    color: var(--accent-primary);
    margin-top: 2px;
    margin-bottom: 1px;
}}
.md-h3 {{
    color: var(--accent-primary);
    margin-top: 1px;
    margin-bottom: 1px;
}}
.md-h4, .md-h5, .md-h6 {{
    color: var(--text-secondary);
    margin-top: 1px;
    margin-bottom: 0px;
}}
.md-bq {{
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--border-default);
    padding-left: 1px;
    margin-top: 1px;
    margin-bottom: 1px;
    color: var(--text-secondary);
}}
.md-muted {{ color: var(--text-muted); }}
.md-em {{ font-style: italic; }}
.md-strong {{ font-weight: bold; }}
.md-strike {{ text-decoration: line-through; }}
.md-list {{
    display: flex;
    flex-direction: column;
    margin-top: 1px;
    margin-bottom: 1px;
}}
.md-li {{ padding-left: 1px; margin-bottom: 0px; }}
.md-li-marker {{ color: var(--text-muted); }}
.md-task {{ color: var(--accent-primary); }}
.md-link-target {{ color: var(--accent-primary); }}

/* ---------- tool card ---------- */

.tool-head {{ display: flex; flex-direction: row; }}
.tool-name {{ color: var(--text-secondary); font-weight: bold; }}
.tool-args {{ color: var(--text-muted); }}
.tool-body {{
    border-left-width: 1px;
    border-left-style: solid;
    border-left-color: var(--border-default);
    padding-left: 1px;
}}
.tool-line {{ color: var(--text-secondary); }}
.tool-activity {{ color: var(--text-muted); }}
.tool-cmd {{ color: var(--tool-cmd); }}
.tool-foot {{
    color: var(--text-muted);
}}
.tool-trunc {{ color: var(--text-muted); font-style: italic; }}
.diff-line-context {{ white-space: pre; }}
.diff-line-insert, .diff-line-delete {{ white-space: pre; }}
.diff-line-hunk {{ color: var(--accent-primary); font-weight: bold; }}
.diff-line-file {{ color: var(--text-secondary); font-weight: bold; }}
.hl-line {{ color: var(--text-secondary); }}

/* Softer palette inside tool output — streaming text stays calm;
   markdown code blocks keep the vivid syntax set above. */
.tool-body .hl-line {{ color: var(--text-muted); }}
.tool-body .syntax-keyword,
.tool-body .syntax-type,
.tool-body .syntax-constant,
.tool-body .syntax-attribute {{ color: var(--accent-secondary); }}
.tool-body .syntax-string,
.tool-body .syntax-function,
.tool-body .syntax-number,
.tool-body .syntax-operator,
.tool-body .syntax-variable-builtin,
.tool-body .syntax-property {{ color: var(--text-secondary); }}
.tool-body .syntax-comment {{ color: var(--text-muted); }}

/* ---------- spinner / tips / completion ---------- */

#spinner-line {{
    flex-shrink: 0;
    display: flex;
    flex-direction: row;
    padding-left: 1px;
    max-height: 1px;
    overflow: hidden;
}}
#spinner-label {{ color: var(--text-secondary); font-weight: bold; }}
#spinner-dots {{ color: var(--text-muted); }}
#spinner-hint {{ color: var(--text-muted); }}

/* ---------- select dropdown + dialogs ---------- */

#queue-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    /* Top rule separates the queue list from the working-status line. */
    border-top: 1px solid var(--border-default);
    overflow: hidden;
}}

#todo-area {{
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    /* Top rule separates the todo strip from the status/queue above. */
    border-top: 1px solid var(--border-default);
    overflow: hidden;
}}
.todo-summary {{ color: var(--text-secondary); font-weight: bold; padding-left: 1px; }}
.todo-row {{ color: var(--text-primary); padding-left: 1px; }}
.todo-active {{ font-weight: bold; }}
.todo-done {{ color: var(--text-muted); }}
.todo-blocked {{ color: var(--status-error); }}
.todo-more {{ color: var(--text-muted); padding-left: 1px; }}
.todo-glyph-done {{ color: var(--status-success); }}
.todo-glyph-active {{ color: var(--accent-primary); }}
.todo-glyph-blocked {{ color: var(--status-error); }}
.todo-glyph-pending {{ color: var(--text-muted); }}

#dialog-area {{ position: relative; flex-shrink: 0; }}
.select-wrap {{ display: flex; flex-direction: column; }}
.select-title {{ color: var(--text-primary); font-weight: bold; padding-left: 1px; }}
.select-filter {{ color: var(--text-muted); padding-left: 1px; }}
.select-filter-label {{ color: var(--text-muted); }}
/* Native pi style: no background block — plain rows below the input
   box, selected row marked by the cursor glyph only. */
.select-dropdown {{
    display: flex;
    flex-direction: column;
}}
.select-option {{ color: var(--text-primary); }}
.select-option.selected {{
    color: var(--text-primary);
    font-weight: bold;
}}
.select-cursor {{ color: var(--accent-primary); }}
.select-desc {{ color: var(--text-muted); }}
.select-badge {{ color: var(--selection-indicator); font-weight: bold; }}
.badge-new {{ color: var(--status-success); }}
.badge-promotion {{ color: var(--accent-primary); }}
.badge-beta {{ color: var(--status-warning); }}
.select-more {{ color: var(--text-muted); padding-left: 2px; }}
.select-footer {{ color: var(--text-muted); padding-left: 1px; border-top: 1px solid var(--border-default); }}
.select-detail-line {{ color: var(--text-secondary); padding-left: 2px; }}
.select-footer-text {{ color: var(--text-muted); }}
.select-empty {{ color: var(--text-muted); }}
.select-inline-hint {{ color: var(--text-muted); }}

.toast {{
    background-color: var(--surface-dropdown);
    color: var(--text-primary);
    border-left: 1px solid var(--accent-primary);
    padding-left: 1px;
}}
.dialog-confirm, .dialog-input, .dialog-editor {{
    background-color: var(--surface-dropdown);
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
}}
.dialog-title {{ color: var(--text-primary); font-weight: bold; }}
.dialog-message {{ color: var(--text-secondary); }}
.dialog-bar {{ display: flex; flex-direction: row; }}
.dialog-btn {{ display: flex; flex-direction: row; margin-right: 2px; }}
.dialog-prompt {{ color: var(--accent-primary); font-weight: bold; }}
.dialog-input-box {{ display: flex; flex-direction: row; }}
.dialog-input-text {{ color: var(--text-primary); }}
.dialog-input-text.placeholder {{ color: var(--text-muted); }}
.dialog-editor-box {{
    border: 1px solid var(--border-default);
    color: var(--text-primary);
    max-height: 8px;
    overflow: hidden;
}}
.dialog-hint {{ display: flex; flex-direction: row; }}
#widget-area {{ flex-shrink: 0; }}
.widget-line {{ color: var(--text-secondary); padding-left: 1px; }}

/* ---------- plugin overlay (extension custom surface) ---------- */

.overlay-card {{
    background-color: var(--surface-overlay);
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
    overflow: hidden;
}}
.ov-title {{ color: var(--text-primary); font-weight: bold; }}
.ov-row {{ display: flex; flex-direction: row; color: var(--text-primary); }}
.ov-row.selected {{ background-color: var(--surface-accent); }}
.ov-hints {{ display: flex; flex-direction: row; border-top: 1px solid var(--border-default); }}
.hint-key {{ color: var(--accent-primary); font-weight: bold; }}
.hint-verb {{ color: var(--text-muted); }}
.hint-sep {{ color: var(--text-muted); }}

/* Span roles — the closed style vocabulary plugins may use. */
.role-text {{ color: var(--text-primary); }}
.role-muted {{ color: var(--text-muted); }}
.role-dim {{ color: var(--text-muted); }}
.role-accent {{ color: var(--accent-primary); }}
.role-warning {{ color: var(--status-warning); }}
.role-error {{ color: var(--status-error); }}
.role-success {{ color: var(--status-success); }}
.role-border {{ color: var(--border-default); }}
.role-selected {{ color: var(--accent-primary); font-weight: bold; }}
.role-hint-key {{ color: var(--accent-primary); font-weight: bold; }}
.role-hint-verb {{ color: var(--text-muted); }}
.bold {{ font-weight: bold; }}

/* ---------- subagent tray / tabs ---------- */

.tray-panel {{
    border: 1px solid var(--border-default);
    background-color: var(--surface-dropdown);
}}
.tray-tabs {{ display: flex; flex-direction: row; border-bottom: 1px solid var(--border-default); }}
.tray-tab {{ padding-left: 1px; padding-right: 1px; color: var(--text-muted); }}
.tray-tab.active {{ background: var(--text-muted); color: var(--text-inverted); }}
.tray-empty {{ color: var(--text-muted); padding-left: 1px; }}
.tray-empty-sub {{ color: var(--text-muted); padding-left: 1px; font-style: italic; }}
.tray-split {{ display: flex; flex-direction: row; }}
.tray-list {{ flex-shrink: 0; min-width: 30px; }}
.tray-item {{ display: flex; flex-direction: row; padding-left: 1px; }}
.tray-item.selected {{ background: var(--surface-accent); color: var(--text-on-surface-accent); }}
.tray-status {{ flex-shrink: 0; width: 10px; }}
.tray-name {{ color: var(--text-primary); }}
.tray-meta {{ color: var(--text-muted); }}
.tray-preview {{
    flex-grow: 1;
    border-left: 1px solid var(--border-default);
    padding-left: 1px;
    overflow: hidden;
}}
.tray-preview-title {{ color: var(--text-primary); font-weight: bold; }}
.tray-preview-meta {{ color: var(--text-muted); }}
.tray-preview-label {{ color: var(--accent-primary); }}
.tray-preview-tool {{ color: var(--text-secondary); }}
.tray-preview-line {{ color: var(--text-muted); }}
.tray-preview-hint {{ color: var(--text-muted); font-style: italic; }}

/* ---------- startup banner / welcome ---------- */

.startup-logo {{ color: var(--accent-primary); font-weight: bold; }}
.welcome-box {{
    border: 1px solid var(--border-default);
    padding-left: 1px;
    padding-right: 1px;
    color: var(--text-secondary);
}}

/* ---------- system message kinds ---------- */

.msg-compaction {{
    color: var(--text-muted);
    background: var(--surface-elevated);
    border-left: 1px solid var(--accent-secondary);
}}
.msg-branch {{
    color: var(--accent-primary);
    background: var(--surface-overlay);
    border-left: 1px solid var(--accent-primary);
}}
.msg-skill {{
    color: var(--status-info);
    background: var(--surface-elevated);
    border-left: 1px solid var(--status-info);
}}
.msg-custom {{
    color: var(--text-secondary);
    background: var(--surface-dropdown);
    border-left: 1px solid var(--border-default);
}}

/* ---------- stable subagent palette ---------- */

{agent_css}
"#,
        text_primary = v.text_primary,
        text_secondary = v.text_secondary,
        text_muted = v.text_muted,
        accent_primary = v.accent_primary,
        accent_secondary = v.accent_secondary,
        fusion_lead = v.fusion_lead,
        fusion_sidekick = v.fusion_sidekick,
        fusion_highlight = v.fusion_highlight,
        status_success = v.status_success,
        status_warning = v.status_warning,
        status_error = v.status_error,
        status_info = v.status_info,
        surface_elevated = v.surface_elevated,
        surface_dropdown = v.surface_dropdown,
        surface_dropdown_selected = v.surface_dropdown_selected,
        surface_overlay = v.surface_overlay,
        text_inverted = v.text_inverted,
        border_default = v.border_default,
        selection_indicator = v.selection_indicator,
        surface_accent = v.surface_accent,
        text_on_surface_accent = v.text_on_surface_accent,
        link_color = v.link_color,
        link_hover = v.link_hover,
        code_block_bg = v.code_block_bg,
        code_inline_bg = v.code_inline_bg,
        tool_cmd = v.tool_cmd,
        diff_insert_bg = v.diff_insert_bg,
        diff_delete_bg = v.diff_delete_bg,
        diff_emphasis_insert_bg = v.diff_emphasis_insert_bg,
        diff_emphasis_delete_bg = v.diff_emphasis_delete_bg,
        user_message_bg = v.user_message_bg,
        syn_keyword = v.syn_keyword,
        syn_string = v.syn_string,
        syn_comment = v.syn_comment,
        syn_function = v.syn_function,
        syn_type = v.syn_type,
        syn_number = v.syn_number,
        syn_constant = v.syn_constant,
        syn_var_builtin = v.syn_var_builtin,
        heading_h1 = v.heading_h1,
        agent_css = agent_css,
    )
}

/// Theme variable values (dark / light), recovered from RECON §12.1.
struct Vars {
    text_primary: &'static str,
    text_secondary: &'static str,
    text_muted: &'static str,
    accent_primary: &'static str,
    accent_secondary: &'static str,
    fusion_lead: &'static str,
    fusion_sidekick: &'static str,
    fusion_highlight: &'static str,
    status_success: &'static str,
    status_warning: &'static str,
    status_error: &'static str,
    status_info: &'static str,
    surface_elevated: &'static str,
    surface_dropdown: &'static str,
    surface_dropdown_selected: &'static str,
    surface_overlay: &'static str,
    text_inverted: &'static str,
    border_default: &'static str,
    selection_indicator: &'static str,
    surface_accent: &'static str,
    text_on_surface_accent: &'static str,
    link_color: &'static str,
    link_hover: &'static str,
    code_block_bg: &'static str,
    code_inline_bg: &'static str,
    /// `$ command` line inside tool cards — the "tool call" accent.
    tool_cmd: &'static str,
    diff_insert_bg: &'static str,
    diff_delete_bg: &'static str,
    diff_emphasis_insert_bg: &'static str,
    diff_emphasis_delete_bg: &'static str,
    user_message_bg: &'static str,
    syn_keyword: &'static str,
    syn_string: &'static str,
    syn_comment: &'static str,
    syn_function: &'static str,
    syn_type: &'static str,
    syn_number: &'static str,
    syn_constant: &'static str,
    syn_var_builtin: &'static str,
    heading_h1: &'static str,
    /// Stable 10-slot subagent palette — hue family preserved per theme,
    /// lightness tuned per scheme so contrast holds on both backgrounds.
    agent_colors: [&'static str; 10],
}

impl Vars {
    fn for_kind(kind: ThemeKind) -> &'static Vars {
        match kind {
            ThemeKind::Dark => &Vars::DARK,
            ThemeKind::Light => &Vars::LIGHT,
            ThemeKind::Nord => &Vars::NORD,
            ThemeKind::SolarizedDark => &Vars::SOLARIZED_DARK,
            ThemeKind::SolarizedLight => &Vars::SOLARIZED_LIGHT,
            ThemeKind::HighContrast => &Vars::HIGH_CONTRAST,
        }
    }

    const DARK: Vars = Vars {
        text_primary: "white",
        text_secondary: "#b0b0b0",
        text_muted: "#7c7c7c",
        accent_primary: "#5ec4ff",
        accent_secondary: "#569cd6",
        fusion_lead: "#4eb6f7",
        fusion_sidekick: "#90a9bf",
        fusion_highlight: "#cfefff",
        status_success: "#4ade80",
        status_warning: "#dcdcaa",
        status_error: "#f44747",
        status_info: "#5ec4ff",
        surface_elevated: "#1f1f1f",
        surface_dropdown: "#2a2a2a",
        surface_dropdown_selected: "#525252",
        surface_overlay: "#002b36",
        text_inverted: "#000000",
        border_default: "#444444",
        selection_indicator: "#b06ab3",
        surface_accent: "#0d1f2d",
        text_on_surface_accent: "#5ec4ff",
        link_color: "#5ec4ff",
        link_hover: "#4f94cd",
        code_block_bg: "#182430",
        code_inline_bg: "#2b2a20",
        tool_cmd: "#ff8787",
        diff_insert_bg: "#0d2818",
        diff_delete_bg: "#2d1517",
        diff_emphasis_insert_bg: "#1e4a28",
        diff_emphasis_delete_bg: "#4a1e22",
        user_message_bg: "#2a2a2a",
        syn_keyword: "#c586c0",
        syn_string: "#ce9178",
        syn_comment: "#6a9955",
        syn_function: "#dcdcaa",
        syn_type: "#4ec9b0",
        syn_number: "#b5cea8",
        syn_constant: "#4fc1ff",
        syn_var_builtin: "#9cdcfe",
        heading_h1: "#d946ef",
        agent_colors: [
            "#ff8787", "#ffaf87", "#ffd787", "#d7af5f", "#afd787", "#87d7af", "#87d7ff", "#afafff",
            "#d7afff", "#ffafd7",
        ],
    };

    const LIGHT: Vars = Vars {
        text_primary: "#1e1e1e",
        text_secondary: "#444444",
        text_muted: "#7f7f7f",
        accent_primary: "#0077aa",
        accent_secondary: "#005a9e",
        // color-mix(in srgb, <dark> 55-58%, black) precomputed.
        fusion_lead: "#2d6990",
        fusion_sidekick: "#54616d",
        fusion_highlight: "#74848c",
        status_success: "#22863a",
        status_warning: "#b08800",
        status_error: "#cb2431",
        status_info: "#0077aa",
        surface_elevated: "#eeeeee",
        surface_dropdown: "#e8e8e8",
        surface_dropdown_selected: "#d6d6d6",
        surface_overlay: "#e8e8e8",
        text_inverted: "#ffffff",
        border_default: "#cccccc",
        selection_indicator: "#6a0dad",
        surface_accent: "#e0f0fa",
        text_on_surface_accent: "#005a9e",
        link_color: "#0077aa",
        link_hover: "#005a9e",
        code_block_bg: "#eaf2fa",
        code_inline_bg: "#f5ecd7",
        tool_cmd: "#cb2431",
        diff_insert_bg: "#d4f5d4",
        diff_delete_bg: "#f5d4d4",
        diff_emphasis_insert_bg: "#a6f3a6",
        diff_emphasis_delete_bg: "#f3a6a6",
        user_message_bg: "#e8e8e8",
        syn_keyword: "#af00db",
        syn_string: "#a31515",
        syn_comment: "#008000",
        syn_function: "#795e26",
        syn_type: "#267f99",
        syn_number: "#098658",
        syn_constant: "#0070c1",
        syn_var_builtin: "#001080",
        heading_h1: "#a200d0",
        // Same hue families as DARK, deepened for light surfaces.
        agent_colors: [
            "#d73a49", "#e36209", "#9a6700", "#7a8f00", "#22863a", "#0e8a94", "#0366d6", "#6f42c1",
            "#7c3aed", "#d33682",
        ],
    };

    /// Nord palette (nordtheme.com): polar night surfaces, frost accents,
    /// aurora status hues.
    const NORD: Vars = Vars {
        text_primary: "#eceff4",
        text_secondary: "#d8dee9",
        text_muted: "#7b88a1",
        accent_primary: "#88c0d0",
        accent_secondary: "#81a1c1",
        fusion_lead: "#88c0d0",
        fusion_sidekick: "#81a1c1",
        fusion_highlight: "#eceff4",
        status_success: "#a3be8c",
        status_warning: "#ebcb8b",
        status_error: "#bf616a",
        status_info: "#88c0d0",
        surface_elevated: "#3b4252",
        surface_dropdown: "#434c5e",
        surface_dropdown_selected: "#4c566a",
        surface_overlay: "#3b4252",
        text_inverted: "#2e3440",
        border_default: "#4c566a",
        selection_indicator: "#b48ead",
        surface_accent: "#39475a",
        text_on_surface_accent: "#88c0d0",
        link_color: "#88c0d0",
        link_hover: "#81a1c1",
        code_block_bg: "#3a4356",
        code_inline_bg: "#4a4a3c",
        tool_cmd: "#bf616a",
        diff_insert_bg: "#2f4438",
        diff_delete_bg: "#4a3238",
        diff_emphasis_insert_bg: "#3f5c46",
        diff_emphasis_delete_bg: "#5c3f46",
        user_message_bg: "#434c5e",
        syn_keyword: "#81a1c1",
        syn_string: "#a3be8c",
        syn_comment: "#616e88",
        syn_function: "#88c0d0",
        syn_type: "#8fbcbb",
        syn_number: "#b48ead",
        syn_constant: "#d08770",
        syn_var_builtin: "#5e81ac",
        heading_h1: "#b48ead",
        agent_colors: [
            "#bf616a", "#d08770", "#ebcb8b", "#a3be8c", "#8fbcbb", "#88c0d0", "#81a1c1", "#5e81ac",
            "#b48ead", "#d78ca8",
        ],
    };

    /// Solarized dark: base03/base02 surfaces, canonical accent hues.
    const SOLARIZED_DARK: Vars = Vars {
        text_primary: "#93a1a1",
        text_secondary: "#839496",
        text_muted: "#586e75",
        accent_primary: "#268bd2",
        accent_secondary: "#2aa198",
        fusion_lead: "#268bd2",
        fusion_sidekick: "#586e75",
        fusion_highlight: "#93a1a1",
        status_success: "#859900",
        status_warning: "#b58900",
        status_error: "#dc322f",
        status_info: "#2aa198",
        surface_elevated: "#073642",
        surface_dropdown: "#0b3d4a",
        surface_dropdown_selected: "#17495a",
        surface_overlay: "#073642",
        text_inverted: "#002b36",
        border_default: "#2a4f5b",
        selection_indicator: "#6c71c4",
        surface_accent: "#0a3d4c",
        text_on_surface_accent: "#268bd2",
        link_color: "#268bd2",
        link_hover: "#2aa198",
        code_block_bg: "#073642",
        code_inline_bg: "#0a3d4c",
        tool_cmd: "#dc322f",
        diff_insert_bg: "#0d3a24",
        diff_delete_bg: "#3d1a1e",
        diff_emphasis_insert_bg: "#1a5a34",
        diff_emphasis_delete_bg: "#6b2a2e",
        user_message_bg: "#073642",
        syn_keyword: "#859900",
        syn_string: "#2aa198",
        syn_comment: "#586e75",
        syn_function: "#268bd2",
        syn_type: "#b58900",
        syn_number: "#d33682",
        syn_constant: "#cb4b16",
        syn_var_builtin: "#6c71c4",
        heading_h1: "#d33682",
        agent_colors: [
            "#dc322f", "#cb4b16", "#b58900", "#859900", "#2aa198", "#268bd2", "#6c71c4", "#d33682",
            "#93a1a1", "#eee8d5",
        ],
    };

    /// Solarized light: base3/base2 surfaces, same accent hues (deepened
    /// where contrast demands).
    const SOLARIZED_LIGHT: Vars = Vars {
        text_primary: "#073642",
        text_secondary: "#586e75",
        text_muted: "#93a1a1",
        accent_primary: "#268bd2",
        accent_secondary: "#2aa198",
        fusion_lead: "#268bd2",
        fusion_sidekick: "#586e75",
        fusion_highlight: "#073642",
        status_success: "#6b8200",
        status_warning: "#b58900",
        status_error: "#dc322f",
        status_info: "#2aa198",
        surface_elevated: "#eee8d5",
        surface_dropdown: "#eae3cb",
        surface_dropdown_selected: "#d9d2b5",
        surface_overlay: "#efe8d0",
        text_inverted: "#fdf6e3",
        border_default: "#cfc8ab",
        selection_indicator: "#6c71c4",
        surface_accent: "#dbe9f0",
        text_on_surface_accent: "#0e5f9e",
        link_color: "#268bd2",
        link_hover: "#2aa198",
        code_block_bg: "#eee8d5",
        code_inline_bg: "#eae3cb",
        tool_cmd: "#dc322f",
        diff_insert_bg: "#cdeccd",
        diff_delete_bg: "#eed5d0",
        diff_emphasis_insert_bg: "#a9dfb0",
        diff_emphasis_delete_bg: "#e8b0a8",
        user_message_bg: "#eee8d5",
        syn_keyword: "#859900",
        syn_string: "#2aa198",
        syn_comment: "#93a1a1",
        syn_function: "#268bd2",
        syn_type: "#b58900",
        syn_number: "#d33682",
        syn_constant: "#cb4b16",
        syn_var_builtin: "#6c71c4",
        heading_h1: "#d33682",
        agent_colors: [
            "#dc322f", "#cb4b16", "#9a7000", "#6b8200", "#1f8a82", "#2075c7", "#6c71c4", "#c22577",
            "#586e75", "#073642",
        ],
    };

    /// High-contrast dark: near-black surfaces, maximum-saturation accents —
    /// the legibility-first theme.
    const HIGH_CONTRAST: Vars = Vars {
        text_primary: "#ffffff",
        text_secondary: "#d4d4d4",
        text_muted: "#9a9a9a",
        accent_primary: "#00d0ff",
        accent_secondary: "#4da3ff",
        fusion_lead: "#00d0ff",
        fusion_sidekick: "#7aa2f7",
        fusion_highlight: "#ffffff",
        status_success: "#50fa7b",
        status_warning: "#ffd700",
        status_error: "#ff5555",
        status_info: "#00d0ff",
        surface_elevated: "#161616",
        surface_dropdown: "#1e1e1e",
        surface_dropdown_selected: "#3a3a3a",
        surface_overlay: "#001d26",
        text_inverted: "#000000",
        border_default: "#777777",
        selection_indicator: "#ff79c6",
        surface_accent: "#06202a",
        text_on_surface_accent: "#00d0ff",
        link_color: "#00d0ff",
        link_hover: "#4da3ff",
        code_block_bg: "#0e1e28",
        code_inline_bg: "#333014",
        tool_cmd: "#ff5555",
        diff_insert_bg: "#0a2e14",
        diff_delete_bg: "#2e0a0e",
        diff_emphasis_insert_bg: "#145a26",
        diff_emphasis_delete_bg: "#5a141c",
        user_message_bg: "#222222",
        syn_keyword: "#ff79c6",
        syn_string: "#f1fa8c",
        syn_comment: "#92a7d0",
        syn_function: "#66d9ef",
        syn_type: "#50fa7b",
        syn_number: "#bd93f9",
        syn_constant: "#ffb86c",
        syn_var_builtin: "#7dcfff",
        heading_h1: "#ff79c6",
        agent_colors: [
            "#ff6e6e", "#ffb86c", "#f1fa8c", "#c7c25e", "#50fa7b", "#8be9fd", "#4da3ff", "#bd93f9",
            "#ff79c6", "#ff92df",
        ],
    };
}

// ---------------------------------------------------------------------------
// CellStyle helpers — for code paths that paint outside the DOM pipeline
// (e.g. cursor post-processing) or need a concrete style value.
// ---------------------------------------------------------------------------

fn rgb(hex: &str) -> Color {
    let (r, g, b) = hex_rgb(hex);
    Color::Rgb(r, g, b)
}

fn hex_rgb(hex: &str) -> (u8, u8, u8) {
    let h = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(0);
    (r, g, b)
}

/// `CellStyle` for a theme variable, resolved for the active theme.
pub struct Theme {
    kind: ThemeKind,
}

impl Theme {
    pub fn new(kind: ThemeKind) -> Self {
        Self { kind }
    }

    fn var(&self, pick: fn(&Vars) -> &'static str) -> Color {
        let s = pick(Vars::for_kind(self.kind));
        if s == "white" {
            return Color::Rgb(255, 255, 255);
        }
        rgb(s)
    }

    // Concrete color accessors — the `CellStyle` side of the CSS-variable
    // mapping. Used by non-DOM paint paths (cursor, future dialogs).
    #[allow(dead_code)]
    pub fn text_primary(&self) -> Color {
        self.var(|v| v.text_primary)
    }
    #[allow(dead_code)]
    pub fn text_muted(&self) -> Color {
        self.var(|v| v.text_muted)
    }
    #[allow(dead_code)]
    pub fn accent(&self) -> Color {
        self.var(|v| v.accent_primary)
    }
    #[allow(dead_code)]
    pub fn error(&self) -> Color {
        self.var(|v| v.status_error)
    }

    /// Fusion gradient endpoints `[lead, highlight, sidekick]` for the
    /// spinner — the RGB twin of the `--fusion-*` vars (spinner paints
    /// inline styles, outside the CSS cascade).
    pub fn fusion(&self) -> [(u8, u8, u8); 3] {
        let v = Vars::for_kind(self.kind);
        [
            hex_rgb(v.fusion_lead),
            hex_rgb(v.fusion_highlight),
            hex_rgb(v.fusion_sidekick),
        ]
    }

    /// Style for the input cursor cell (inverse video block).
    pub fn cursor_style(&self) -> CellStyle {
        CellStyle {
            fg: Color::Reset,
            bg: Color::Reset,
            underline: Color::Reset,
            modifier: Modifier::INVERSE,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_roundtrip() {
        for kind in ThemeKind::ALL {
            assert_eq!(
                ThemeKind::from_name(kind.name()),
                Some(*kind),
                "{}",
                kind.name()
            );
        }
        assert_eq!(
            ThemeKind::from_name("solarized"),
            Some(ThemeKind::SolarizedDark)
        );
        assert_eq!(ThemeKind::from_name("hc"), Some(ThemeKind::HighContrast));
        assert_eq!(ThemeKind::from_name("bogus"), None);
    }

    #[test]
    fn every_theme_emits_all_vars_and_agent_palette() {
        for kind in ThemeKind::ALL {
            let css = stylesheet(*kind);
            for var in [
                "--text-primary",
                "--accent-primary",
                "--surface-elevated",
                "--border-default",
                "--status-error",
                "--diff-insert-bg",
                "--fusion-lead",
                "--link-color",
            ] {
                assert!(css.contains(var), "{var} missing for {}", kind.name());
            }
            for i in 0..10 {
                assert!(
                    css.contains(&format!(".agent-color-{i}")),
                    "agent-color-{i} missing for {}",
                    kind.name()
                );
            }
            assert!(
                css.contains(".text-heading-h1"),
                "heading-h1 missing for {}",
                kind.name()
            );
        }
    }

    /// Every `--var: <value>` in the :root block is a real color
    /// (#rrggbb / white / transparent) — catches palette typos that
    /// stylo would silently drop to black.
    #[test]
    fn every_var_value_is_a_color() {
        for kind in ThemeKind::ALL {
            let css = stylesheet(*kind);
            let root = css
                .split(":root")
                .nth(1)
                .unwrap()
                .split('}')
                .next()
                .unwrap();
            for decl in root.split(';').filter(|d| d.contains("--")) {
                let v = decl.split(':').nth(1).unwrap().trim();
                let ok = v == "white"
                    || v == "transparent"
                    || (v.starts_with('#')
                        && v.len() == 7
                        && v[1..].chars().all(|c| c.is_ascii_hexdigit()));
                assert!(
                    ok,
                    "{kind:?} bad value {v:?} in {decl:?}",
                    kind = kind,
                    v = v,
                    decl = decl
                );
            }
        }
    }

    #[test]
    fn color_scheme_matches_surface_darkness() {
        use blitz_traits::shell::ColorScheme;
        assert_eq!(ThemeKind::Dark.color_scheme(), ColorScheme::Dark);
        assert_eq!(ThemeKind::Light.color_scheme(), ColorScheme::Light);
        assert_eq!(ThemeKind::SolarizedLight.color_scheme(), ColorScheme::Light);
        assert_eq!(ThemeKind::Nord.color_scheme(), ColorScheme::Dark);
    }

    #[test]
    fn fusion_matches_vars() {
        let dark = Theme::new(ThemeKind::Dark).fusion();
        assert_eq!(dark[0], (0x4e, 0xb6, 0xf7));
        let light = Theme::new(ThemeKind::Light).fusion();
        assert_eq!(light[0], (0x2d, 0x69, 0x90));
    }
}
