//! `spinner` — Devin-style 8-frame braille snake with fusion gradient,
//! `InterruptHint`, and a `Thinking {n}s` label.
//!
//! DOM shape:
//! ```text
//! #spinner-line (row, hidden when idle)
//!   ├─ #spinner-glyph "{frame}"   (per-frame fusion-gradient color)
//!   ├─ #spinner-label " Thinking" (accent)
//!   ├─ #spinner-dots  (unused — kept for DOM shape stability)
//!   └─ #spinner-hint  " · {hint}"          (InterruptHint: bold accent)
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;

/// Keep the working indicator calm on a 33ms app tick. The glyph changes
/// about every 165ms.
pub const SPINNER_FRAME_TICKS: u64 = 5;

/// Fusion gradient endpoints `[lead, highlight, sidekick]` — supplied by
/// `Theme::fusion()` (the RGB twin of the `--fusion-*` vars; the spinner
/// paints an inline style per frame, outside the CSS cascade).
pub type Fusion = [(u8, u8, u8); 3];

fn lerp(a: u8, b: u8, t: f32) -> u8 {
    (a as f32 + (b as f32 - a as f32) * t).round() as u8
}

fn mix(a: (u8, u8, u8), b: (u8, u8, u8), t: f32) -> (u8, u8, u8) {
    (lerp(a.0, b.0, t), lerp(a.1, b.1, t), lerp(a.2, b.2, t))
}

/// The fusion-gradient color for spinner frame `frame` (0..16).
/// Ping-pong: 0..8 lead→highlight, 8..16 highlight→sidekick.
pub fn fusion_color(frame: usize, fusion: &Fusion) -> (u8, u8, u8) {
    let f = frame % 16;
    if f < 8 {
        mix(fusion[0], fusion[1], f as f32 / 7.0)
    } else {
        mix(fusion[1], fusion[2], (f - 8) as f32 / 8.0)
    }
}

/// Build the `#spinner-line` under `parent`.
/// Returns `(line, glyph_span, label_text, dots_text, hint_text)`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> SpinnerHandles {
    let line = div(m, parent, "");
    m.set_attribute(line, qual("id"), "spinner-line");

    let (glyph_span, glyph_text) = span_text(m, line, "", "");
    m.set_attribute(glyph_span, qual("id"), "spinner-glyph");
    let (label_span, label_text) = span_text(m, line, "", "");
    m.set_attribute(label_span, qual("id"), "spinner-label");
    let (dots_span, dots_text) = span_text(m, line, "", "");
    m.set_attribute(dots_span, qual("id"), "spinner-dots");
    let (hint_span, hint_text) = span_text(m, line, "", "");
    m.set_attribute(hint_span, qual("id"), "spinner-hint");

    SpinnerHandles {
        line,
        glyph_span,
        glyph_text,
        label_text,
        dots_text,
        hint_text,
    }
}

/// Node ids the app patches each frame.
#[derive(Clone, Copy)]
pub struct SpinnerHandles {
    pub line: NodeId,
    pub glyph_span: NodeId,
    /// The glyph span's text child — avoids a `child_ids` ThinVec
    /// clone per sync.
    pub glyph_text: NodeId,
    pub label_text: NodeId,
    pub dots_text: NodeId,
    pub hint_text: NodeId,
}

/// Sync the spinner line for the current tick.
///
/// * `active` — whether the agent is streaming (line hidden when false).
/// * `tick` — app tick counter (33ms); frame = `(tick/5) % 16`.
/// * `label` — the working-state label ("Thinking" / "Interrupting").
/// * `hint` — the `InterruptHint` text (e.g. "esc to interrupt").
pub fn sync(
    m: &mut DocumentMutator<'_>,
    h: &SpinnerHandles,
    active: bool,
    tick: u64,
    label: &str,
    hint: &str,
    mode: GlyphMode,
    fusion: &Fusion,
) {
    if !active {
        m.set_style_property(h.line, "display", "none");
        return;
    }
    m.set_style_property(h.line, "display", "flex");

    // Frame + fusion gradient color (inline style — per-frame value).
    let frame = (tick / SPINNER_FRAME_TICKS) as usize % 16;
    let (r, g, b) = fusion_color(frame, fusion);
    m.set_style_property(h.glyph_span, "color", &format!("rgb({r},{g},{b})"));
    m.set_node_text(h.glyph_text, mode.spinner_frame(tick / SPINNER_FRAME_TICKS));

    m.set_node_text(h.label_text, &format!(" {label}"));
    m.set_node_text(h.dots_text, "");
    if hint.is_empty() {
        m.set_node_text(h.hint_text, "");
    } else {
        m.set_node_text(h.hint_text, &format!(" · {hint}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FUSION: Fusion = [(0x4e, 0xb6, 0xf7), (0xcf, 0xef, 0xff), (0x90, 0xa9, 0xbf)];

    #[test]
    fn gradient_endpoints() {
        assert_eq!(fusion_color(0, &FUSION), FUSION[0]);
        assert_eq!(fusion_color(7, &FUSION), FUSION[1]);
        assert_eq!(fusion_color(16, &FUSION), FUSION[0]); // wraps
    }
}
