//! `banner` — startup banner + welcome box (RECON §12.5
//! `startup_banner::StartupBanner` + `welcome_box::WelcomeBox`).
//!
//! Rendered once as the first child of `#messages-inner`; dismissed by
//! the first submitted prompt (`AppState::banner_visible`).
//!
//! ```text
//! .startup-logo   "pi-graph-fluent-tui"
//! .welcome-box
//!    "Upstream source: "
//!    <a href> upstream repository
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{attr, div, qual, span_text};

/// Upstream source link (opens in the system browser via `data-hit-link`).
pub const WELCOME_URL: &str = "https://github.com/catlog22/pi-maestro-flow";

/// Build the banner under `parent`; returns the banner root node.
pub fn render(m: &mut DocumentMutator<'_>, parent: NodeId) -> NodeId {
    let root = div(m, parent, "startup-banner");
    let logo = div(m, root, "startup-logo");
    span_text(m, logo, "", "pi-graph-fluent-tui");

    let wb = div(m, root, "welcome-box");
    span_text(m, wb, "", "Upstream source: ");
    let a = m.create_element(qual("a"), vec![attr("href", WELCOME_URL)]);
    m.append_children(wb, &[a]);
    m.set_attribute(a, qual("data-hit-link"), WELCOME_URL);
    let t = m.create_text_node(WELCOME_URL);
    m.append_children(a, &[t]);
    root
}
