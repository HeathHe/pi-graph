//! `todo` — persistent todo strip between the working status line and
//! the input (`#todo-area`, hidden while the list is empty). Mirrors
//! cockpit's list mode: summary first, then status-ranked rows.
//!
//! DOM shape:
//! ```text
//! #todo-area (column, border-top rules it off from the status line)
//!   ├─ .todo-summary  "Todo 2/5 · 1 running · 1 blocked"
//!   ├─ .todo-row.todo-{done|active|blocked|pending}
//!   │     > .todo-glyph-{…} "{glyph}" + "{subject}"
//!   └─ .todo-more     "… +N more"
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, span_text};
use crate::components::glyphs::GlyphMode;
use crate::state::{AppState, TodoStatus};

/// Rows visible before the strip collapses into `… +N more`.
pub const TODO_MAX_VISIBLE: usize = 6;

/// Everything `sync` renders — the app skips the rebuild while this
/// is unchanged.
pub fn signature(state: &AppState) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut s = std::collections::hash_map::DefaultHasher::new();
    for t in &state.todos {
        t.id.hash(&mut s);
        t.status.hash(&mut s);
        t.subject.hash(&mut s);
    }
    s.finish()
}

pub(crate) fn status_rank(status: TodoStatus) -> u8 {
    match status {
        TodoStatus::InProgress => 0,
        TodoStatus::Pending => 1,
        TodoStatus::Blocked => 2,
        TodoStatus::Completed => 3,
    }
}

/// Numeric suffix of an id for stable ordering (`task-12` → 12).
pub(crate) fn id_order(id: &str) -> u64 {
    id.chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>()
        .parse()
        .unwrap_or(u64::MAX)
}

pub(crate) fn glyph(mode: GlyphMode, status: TodoStatus) -> (&'static str, &'static str) {
    match status {
        TodoStatus::Completed => (mode.ok(), "todo-glyph-done"),
        TodoStatus::InProgress => (mode.running(), "todo-glyph-active"),
        TodoStatus::Blocked => (mode.err(), "todo-glyph-blocked"),
        TodoStatus::Pending => (mode.pending(), "todo-glyph-pending"),
    }
}

fn row_class(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Completed => "todo-row todo-done",
        TodoStatus::InProgress => "todo-row todo-active",
        TodoStatus::Blocked => "todo-row todo-blocked",
        TodoStatus::Pending => "todo-row todo-pending",
    }
}

/// Sync the todo strip from state.
pub fn sync(m: &mut DocumentMutator<'_>, area: NodeId, state: &AppState, mode: GlyphMode) {
    crate::components::dom::drop_children(m, area);
    if state.todos.is_empty() {
        m.set_style_property(area, "display", "none");
        return;
    }
    m.set_style_property(area, "display", "flex");

    let total = state.todos.len();
    let done = state
        .todos
        .iter()
        .filter(|t| t.status == TodoStatus::Completed)
        .count();
    let running = state
        .todos
        .iter()
        .filter(|t| t.status == TodoStatus::InProgress)
        .count();
    let blocked = state
        .todos
        .iter()
        .filter(|t| t.status == TodoStatus::Blocked)
        .count();
    let mut summary = format!("Todo {done}/{total}");
    if running > 0 {
        summary.push_str(&format!(" · {running} running"));
    }
    if blocked > 0 {
        summary.push_str(&format!(" · {blocked} blocked"));
    }
    let s = div(m, area, "todo-summary");
    span_text(m, s, "", &summary);

    let mut ordered: Vec<&crate::state::TodoItem> = state.todos.iter().collect();
    ordered.sort_by(|a, b| {
        status_rank(a.status)
            .cmp(&status_rank(b.status))
            .then(id_order(&a.id).cmp(&id_order(&b.id)))
            .then(a.id.cmp(&b.id))
    });
    for it in ordered.iter().take(TODO_MAX_VISIBLE) {
        let row = div(m, area, row_class(it.status));
        let (g, class) = glyph(mode, it.status);
        let (_gs, _t) = span_text(m, row, class, g);
        span_text(m, row, "", &format!(" {}", it.subject));
    }
    let hidden = ordered.len().saturating_sub(TODO_MAX_VISIBLE);
    if hidden > 0 {
        let row = div(m, area, "todo-more");
        span_text(m, row, "", &format!("… +{hidden} more"));
    }
}
