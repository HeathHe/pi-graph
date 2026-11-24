//! `MessageList` — the scrollable conversation area.
//!
//! DOM shape:
//! ```text
//! #messages (flex:1, overflow:hidden, data-hit-scroll)
//!   ├─ .msg.msg-user      > text
//!   ├─ .msg.msg-assistant > markdown blocks (pulldown-cmark → styled DOM)
//!   ├─ .msg.msg-thinking  > text
//!   ├─ .msg.msg-tool      > tool_card (head + truncated/diff body)
//!   └─ …
//! ```
//!
//! Incremental sync: new messages append bubbles; assistant text changes
//! re-render the markdown subtree in place; tool cards rebuild when
//! `msg.dirty` (status/output/expanded changed).

use blitz_dom::{BaseDocument, DocumentMutator, NodeId};

use crate::components::dom::{attr, div, qual, span_text};
use crate::components::{markdown, tool_card};
use crate::state::{AppState, Message, MsgKind};

/// Build the `#messages` container under `parent`, wrapped in a
/// `.messages-wrap` row with a 1-cell `#scrollbar` track.
/// Returns `(wrap, container, container, thumb)` — bubbles append
/// directly; content flows top-down and `scroll_offset` on the
/// container scrolls it. `data-hit-scroll` marks the region for mouse
/// wheel routing.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> (NodeId, NodeId, NodeId, NodeId) {
    let wrap = div(m, parent, "messages-wrap");
    let container = div(m, wrap, "");
    m.set_attribute(container, qual("id"), "messages");
    m.set_attribute(container, qual("data-hit-scroll"), "");
    let track = div(m, wrap, "");
    m.set_attribute(track, qual("id"), "scrollbar");
    let thumb = div(m, track, "scrollbar-thumb");
    (wrap, container, container, thumb)
}

/// Rebuild every message bubble under `inner` from `state.messages`.
///
/// Used for the initial build and after structural resets (Ctrl+L).
pub fn rebuild(m: &mut DocumentMutator<'_>, inner: NodeId, state: &mut AppState) {
    // `drop_children` removes each child with parent layout damage (the
    // bulk `remove_and_drop_all_children` leaves the parent's taffy cache
    // stale) and clears `layout_children`/`paint_children` so the next
    // resolve can't walk dropped NodeIds (invalid SlotMap key panic).
    crate::components::dom::drop_children(m, inner);
    // Banner node was dropped with the children.
    state.banner_node = None;
    if state.banner_visible {
        let b = crate::components::banner::render(m, inner);
        state.banner_node = Some(b);
    }
    let glyphs = state.glyphs;
    let tick = state.tick;
    for msg in state.messages.iter_mut() {
        msg.node_id = None;
        msg.text_node_id = None;
        msg.glyph_node_id = None;
        msg.rendered_len = 0;
        msg.dirty = false;
        append_bubble(m, inner, msg, tick, glyphs, &state.tray.entries);
    }
    state.needs_rebuild = false;
}

/// Append one `.msg` bubble for `msg`, recording node ids back into it.
/// The full `class` attribute for a bubble — kind + agent palette +
/// hidden + search marks. Pure function of msg/tray state; `sync`
/// rewrites the attribute when `search_mark` diverges from
/// `rendered_search_mark`.
fn bubble_class(msg: &Message, tray_entries: &[crate::state::TrayEntry]) -> String {
    let mut class = match msg.kind {
        MsgKind::User => "msg msg-user".to_string(),
        MsgKind::Assistant => "msg msg-assistant".to_string(),
        MsgKind::Thinking => "msg msg-thinking".to_string(),
        MsgKind::Tool => "msg msg-tool".to_string(),
        MsgKind::Error => "msg msg-error".to_string(),
        MsgKind::System => "msg msg-system".to_string(),
        MsgKind::Compaction => "msg msg-compaction".to_string(),
        MsgKind::Branch => "msg msg-branch".to_string(),
        MsgKind::Skill => "msg msg-skill".to_string(),
        MsgKind::Custom => "msg msg-custom".to_string(),
    };
    if let Some(entry) = msg.tray_entry.and_then(|idx| tray_entries.get(idx)) {
        if entry.kind == crate::state::TrayKind::Subagent {
            class.push_str(&format!(" agent-color-{}", entry.color_idx));
        }
    }
    // Devin subagent/mode: nested cards of a backgrounded entry are
    // hidden until it finishes (or is foregrounded).
    if let Some(owner) = msg.nested_under {
        if let Some(e) = tray_entries.get(owner) {
            if !e.foregrounded && e.status == crate::state::TrayStatus::Running {
                class.push_str(" msg-hidden");
            }
        }
    }
    match msg.search_mark {
        crate::state::SearchMark::Hit => class.push_str(" msg-search-hit"),
        crate::state::SearchMark::Current => class.push_str(" msg-search-current"),
        crate::state::SearchMark::None => {}
    }
    class
}

fn append_bubble(
    m: &mut DocumentMutator<'_>,
    inner: NodeId,
    msg: &mut Message,
    tick: u64,
    glyphs: crate::components::glyphs::GlyphMode,
    tray_entries: &[crate::state::TrayEntry],
) {
    let class = bubble_class(msg, tray_entries);
    let bubble = m.create_element(qual("div"), vec![attr("class", &class)]);
    m.append_children(inner, &[bubble]);
    msg.node_id = Some(bubble);
    msg.rendered_search_mark = msg.search_mark;

    match msg.kind {
        MsgKind::Tool => {
            let entry = msg.tray_entry.and_then(|i| tray_entries.get(i));
            let (g, t) = tool_card::build_card(m, bubble, msg, glyphs, entry);
            msg.glyph_node_id = Some(g);
            msg.text_node_id = Some(t);
        }
        MsgKind::Assistant => {
            markdown::render(m, bubble, &msg.text);
            msg.text_node_id = None;
        }
        MsgKind::Thinking => {
            build_thinking(m, bubble, msg);
        }
        _ => {
            let t = m.create_text_node(&msg.text);
            m.append_children(bubble, &[t]);
            msg.text_node_id = Some(t);
        }
    }
    msg.rendered_len = msg.text.len();
    msg.last_render_tick = tick;
}

/// Thinking bubble: full text while streaming; once sealed it collapses
/// to `▸ Thinking — {first line}` (click / ctrl+o expands).
fn build_thinking(m: &mut DocumentMutator<'_>, bubble: NodeId, msg: &mut Message) {
    if msg.sealed && !msg.expanded {
        let row = div(m, bubble, "thinking-collapsed");
        m.set_attribute(row, qual("data-hit-expand"), "");
        let preview: String = msg
            .text
            .lines()
            .next()
            .unwrap_or("")
            .chars()
            .take(60)
            .collect();
        span_text(
            m,
            row,
            "",
            &format!("▸ Thinking — {preview} (ctrl+o to expand)"),
        );
        msg.text_node_id = None;
        return;
    }
    let t = m.create_text_node(&msg.text);
    m.append_children(bubble, &[t]);
    msg.text_node_id = Some(t);
}

/// Re-render a bubble's children in place (markdown re-render / tool
/// card state change). Keeps the bubble node itself.
fn rebuild_bubble(
    m: &mut DocumentMutator<'_>,
    msg: &mut Message,
    tick: u64,
    glyphs: crate::components::glyphs::GlyphMode,
    tray_entries: &[crate::state::TrayEntry],
) {
    let Some(bubble) = msg.node_id else { return };
    crate::components::dom::drop_children(m, bubble);
    match msg.kind {
        MsgKind::Tool => {
            let entry = msg.tray_entry.and_then(|i| tray_entries.get(i));
            let (g, t) = tool_card::build_card(m, bubble, msg, glyphs, entry);
            msg.glyph_node_id = Some(g);
            msg.text_node_id = Some(t);
        }
        MsgKind::Assistant => {
            markdown::render(m, bubble, &msg.text);
            msg.text_node_id = None;
        }
        MsgKind::Thinking => {
            build_thinking(m, bubble, msg);
        }
        _ => {
            let t = m.create_text_node(&msg.text);
            m.append_children(bubble, &[t]);
            msg.text_node_id = Some(t);
        }
    }
    msg.rendered_len = msg.text.len();
    msg.last_render_tick = tick;
    msg.dirty = false;
    msg.rendered_search_mark = msg.search_mark;
}

/// Minimum ticks between streamed (non-dirty, unsealed) structural
/// re-renders — ~100ms at the 33ms tick.
const STREAM_RENDER_INTERVAL: u64 = 3;

/// Sync the DOM with `state.messages` incrementally:
/// * `state.needs_rebuild` → full rebuild (Ctrl+L);
/// * messages without a `node_id` get a new appended bubble;
/// * `msg.dirty` or changed text → re-render the bubble's children
///   (markdown for assistant, card for tools);
/// * plain messages patch their text node in place.
///
/// Returns `true` when any mutation was applied.
pub fn sync(m: &mut DocumentMutator<'_>, inner: NodeId, state: &mut AppState) -> bool {
    if state.needs_rebuild {
        rebuild(m, inner, state);
        return true;
    }
    let glyphs = state.glyphs;
    let mut changed = false;

    // Startup banner: prepend once, drop when dismissed.
    if state.banner_visible && state.banner_node.is_none() {
        let b = crate::components::banner::render(m, inner);
        state.banner_node = Some(b);
        changed = true;
    } else if !state.banner_visible {
        if let Some(b) = state.banner_node.take() {
            crate::components::dom::drop_node(m, inner, b);
            changed = true;
        }
    }
    for msg in state.messages.iter_mut() {
        if msg.node_id.is_none() {
            append_bubble(m, inner, msg, state.tick, glyphs, &state.tray.entries);
            changed = true;
            continue;
        }
        // Search-mark drift: rewrite the class attribute only (no
        // structural rebuild — the mark is render-only).
        if msg.search_mark != msg.rendered_search_mark {
            if let Some(bubble) = msg.node_id {
                let class = bubble_class(msg, &state.tray.entries);
                m.set_attribute(bubble, qual("class"), &class);
                msg.rendered_search_mark = msg.search_mark;
                changed = true;
            }
        }
        if msg.dirty || msg.rendered_len != msg.text.len() {
            match msg.kind {
                // Markdown/tool/thinking bubbles re-render their subtree
                // (thinking collapses on seal → structural change).
                // Streamed appends (dirty=false, unsealed) throttle to
                // STREAM_RENDER_INTERVAL ticks — a per-delta rebuild is
                // O(message²) markdown re-parsing.
                MsgKind::Assistant | MsgKind::Thinking
                    if msg.dirty
                        || msg.sealed
                        || state.tick.saturating_sub(msg.last_render_tick)
                            >= STREAM_RENDER_INTERVAL =>
                {
                    rebuild_bubble(m, msg, state.tick, glyphs, &state.tray.entries);
                    changed = true;
                }
                // Tool output is often delivered in many small deltas. Keep
                // the call header responsive, but batch its live body until
                // the normal stream interval; a terminal result is immediate.
                MsgKind::Tool
                    if msg.sealed
                        || msg.tool_status != Some('●')
                        || state.tick.saturating_sub(msg.last_render_tick)
                            >= STREAM_RENDER_INTERVAL =>
                {
                    rebuild_bubble(m, msg, state.tick, glyphs, &state.tray.entries);
                    changed = true;
                }
                // Throttled streamed append: leave the stale render in
                // place; the next interval (or seal) catches up.
                MsgKind::Assistant | MsgKind::Tool | MsgKind::Thinking => {}
                // Plain bubbles patch the single text node.
                _ => {
                    if let Some(tid) = msg.text_node_id {
                        m.set_node_text(tid, &msg.text);
                        msg.rendered_len = msg.text.len();
                        msg.dirty = false;
                        changed = true;
                    }
                }
            }
        }
    }

    changed
}

/// Sync the thinking-trace overlay (F3): swaps `#messages-wrap` for
/// `#trace` when `state.trace_open` diverges from `rendered_open`, and
/// rewrites the trace text when `state.trace_signature()` changed
/// (streamed thinking appends grow the len).
pub fn sync_trace(
    m: &mut DocumentMutator<'_>,
    wrap: NodeId,
    trace: NodeId,
    trace_text: NodeId,
    state: &mut AppState,
    rendered_open: &mut bool,
) {
    if *rendered_open != state.trace_open {
        m.set_style_property(
            wrap,
            "display",
            if state.trace_open { "none" } else { "flex" },
        );
        m.set_style_property(
            trace,
            "display",
            if state.trace_open { "flex" } else { "none" },
        );
        *rendered_open = state.trace_open;
    }
    let sig = state.trace_signature();
    if state.trace_open && sig != state.trace_sig {
        m.set_node_text(trace_text, &state.thinking_trace());
        state.trace_sig = sig;
    }
}

/// Clamp `state.scroll` to the valid range for the current layout and
/// write it into the `#messages` node's `scroll_offset`. Also syncs the
/// `#scrollbar` thumb (height ∝ view/content, top ∝ scroll/max_scroll),
/// gated on `state.scrollbar_sig` so unchanged frames skip the style
/// writes (every `set_style_property` is layout damage).
///
/// Must run *after* `doc.resolve()` (needs `scrollable_overflow`).
pub fn apply_scroll(
    doc: &mut BaseDocument,
    container: NodeId,
    thumb: NodeId,
    state: &mut AppState,
) {
    let (content_h, view_h) = {
        let Some(node) = doc.get_node(container) else {
            return;
        };
        let overflow = node.scrollable_overflow();
        let content_h = overflow.height();
        let view_h = node.final_layout().size.height as f64;
        (content_h, view_h)
    };
    let max_scroll = (content_h - view_h).max(0.0);
    if state.follow_tail {
        state.scroll = max_scroll as u32;
    } else {
        state.scroll = (state.scroll as f64).min(max_scroll) as u32;
    }
    if let Some(node) = doc.get_node_mut(container) {
        node.scroll_offset_mut().y = state.scroll as f64;
    }

    let sig = (content_h as u32, view_h as u32, state.scroll);
    if sig == state.scrollbar_sig {
        return;
    }
    state.scrollbar_sig = sig;
    let mut m = doc.mutate();
    if max_scroll <= 0.0 || view_h <= 0.0 {
        m.set_style_property(thumb, "display", "none");
        return;
    }
    m.set_style_property(thumb, "display", "block");
    let thumb_h = ((view_h / content_h) * view_h).max(1.0).min(view_h);
    let top = ((state.scroll as f64 / max_scroll) * (view_h - thumb_h)).max(0.0);
    m.set_style_property(thumb, "height", &format!("{thumb_h}px"));
    m.set_style_property(thumb, "margin-top", &format!("{top}px"));
}
