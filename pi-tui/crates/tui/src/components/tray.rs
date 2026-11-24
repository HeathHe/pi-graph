//! `tray` — subagent/shell tray panel (RECON §12.2 `TrayContent`).
//!
//! DOM shape (rendered inside `#dialog-area`, above the input):
//! ```text
//! .tray-panel
//!   ├─ .tray-tabs
//!   │    ├─ .tray-tab[.active] "Subagents"
//!   │    ├─ .tray-tab "Cloud agents"
//!   │    └─ .tray-tab "Shells ({n})"
//!   ├─ .tray-empty + .tray-empty-sub        (empty state)
//!   └─ .tray-split (row)
//!        ├─ .tray-list (column)
//!        │    └─ .tray-item[.selected]
//!        │         ├─ .tray-status  "[~]"/"Completed"/"Failed"/"Cancelled"
//!        │         ├─ .tray-name    "{title}"   (agent palette color)
//!        │         └─ .tray-meta    " {n} tools · {n}s"
//!        └─ .tray-preview (column, selected entry)
//!             ├─ .tray-preview-title  "{title}"
//!             ├─ .tray-preview-meta   "{tool} · {model} · {status} · {n}s"
//!             ├─ .tray-preview-label  "Recent tools"
//!             ├─ .tray-preview-tool   "· {name}"  (≤5)
//!             ├─ .tray-preview-label  "Output"
//!             └─ .tray-preview-line   "{line}"    (≤4 tail lines)
//! ```
//!
//! Keys (handled in `app::handle_tray_key`): tab/←→ switch tabs,
//! ↑↓ navigate, enter view, x kill, f foreground, esc close.

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;
use crate::components::todo;
use crate::state::{
    Message, MsgKind, TodoItem, TodoStatus, TrayEntry, TrayKind, TrayState, TrayStatus, TrayTab,
};

/// Milliseconds per app tick (33ms frame tick).
const TICK_MS: u64 = 33;

/// Preview tail lines shown for the selected entry.
const PREVIEW_LINES: usize = 4;

fn status_label(e: &TrayEntry) -> &'static str {
    match e.status {
        // Devin `subagent/mode`: backgrounded running entries are
        // "parked" (output hidden until finish).
        TrayStatus::Running if !e.foregrounded => "[bg]",
        TrayStatus::Running => "[~]",
        TrayStatus::Done => "Completed",
        TrayStatus::Failed => "Failed",
        TrayStatus::Cancelled => "Cancelled",
    }
}

fn duration_secs(e: &TrayEntry, now: u64) -> u64 {
    let end = e.end_tick.unwrap_or(now);
    end.saturating_sub(e.start_tick) * TICK_MS / 1000
}

/// Render the tray panel under `parent` (rebuilt each sync).
/// `now` is the current `AppState.tick` for live durations; `messages`
/// feeds the preview's output tail; `todos` backs the Todos tab.
pub fn render(
    m: &mut DocumentMutator<'_>,
    parent: NodeId,
    tray: &TrayState,
    now: u64,
    messages: &[Message],
    todos: &[TodoItem],
    mode: GlyphMode,
) {
    let panel = div(m, parent, "tray-panel");

    // Tabs.
    let tabs = div(m, panel, "tray-tabs");
    let shells = tray
        .entries
        .iter()
        .filter(|e| e.kind == TrayKind::Shell)
        .count();
    for tab in [TrayTab::Subagents, TrayTab::Cloud, TrayTab::Shells, TrayTab::Todos] {
        let cls = if tab == tray.tab {
            "tray-tab active"
        } else {
            "tray-tab"
        };
        let t = div(m, tabs, cls);
        span_text(m, t, "", &tab.label(shells, todos.len()));
    }

    if tray.tab == TrayTab::Todos {
        render_todos(m, panel, tray, todos, mode);
        return;
    }

    let visible = tray.visible();
    if visible.is_empty() {
        let (line, sub) = match tray.tab {
            TrayTab::Subagents => (
                "No subagents yet.",
                "Ask pi to spawn a subagent for parallel or focused work.",
            ),
            TrayTab::Cloud => (
                "No cloud agents yet.",
                "Run /handoff to launch an agent on its own machine.",
            ),
            TrayTab::Shells => ("No shells yet.", "Ctrl+B runs a command in the background."),
            TrayTab::Todos => unreachable!(),
        };
        let e = div(m, panel, "tray-empty");
        span_text(m, e, "", line);
        let s = div(m, panel, "tray-empty-sub");
        span_text(m, s, "", sub);
        return;
    }

    // Split: entry list (left) + selected-entry preview (right).
    let split = div(m, panel, "tray-split");
    let list = div(m, split, "tray-list");
    for (row, &ei) in visible.iter().enumerate() {
        let e = &tray.entries[ei];
        let selected = row == tray.cursor;
        let item = div(
            m,
            list,
            if selected {
                "tray-item selected"
            } else {
                "tray-item"
            },
        );
        m.set_attribute(item, qual("data-hit-tray"), &row.to_string());
        let st = div(m, item, "tray-status");
        span_text(m, st, "", status_label(e));
        let name_class = if e.kind == TrayKind::Subagent {
            format!("tray-name agent-color-{}", e.color_idx)
        } else {
            "tray-name".to_string()
        };
        let name = div(m, item, &name_class);
        span_text(m, name, "", &format!(" {}", e.title));
        let meta = div(m, item, "tray-meta");
        span_text(
            m,
            meta,
            "",
            &format!("  {} tools · {}s", e.tools, duration_secs(e, now)),
        );
    }

    // Preview pane for the selected entry (Devin subagent detail).
    if let Some(&ei) = visible.get(tray.cursor) {
        let e = &tray.entries[ei];
        let pv = div(m, split, "tray-preview");
        let title_class = if e.kind == TrayKind::Subagent {
            format!("tray-preview-title agent-color-{}", e.color_idx)
        } else {
            "tray-preview-title".to_string()
        };
        let t = div(m, pv, &title_class);
        span_text(m, t, "", &e.title);
        let meta = div(m, pv, "tray-preview-meta");
        span_text(
            m,
            meta,
            "",
            &format!(
                "{} · {} · {} · {}s",
                e.tool,
                if e.model.is_empty() { "-" } else { &e.model },
                status_label(e),
                duration_secs(e, now),
            ),
        );
        if !e.recent_tools.is_empty() {
            let l = div(m, pv, "tray-preview-label");
            span_text(m, l, "", "Recent tools");
            for (name, target) in &e.recent_tools {
                let r = div(m, pv, "tray-preview-tool");
                let text = if target.is_empty() {
                    format!("· {name}")
                } else {
                    format!("· {name} {target}")
                };
                span_text(m, r, "", &text);
            }
        }
        // Output tail: per-agent rows show the agent's own output —
        // the rolling `outputTail` window when present, else the last
        // message; call-level rows tail the shared tool card.
        if !e.output_tail.is_empty() {
            let l = div(m, pv, "tray-preview-label");
            span_text(m, l, "", "Output");
            for line in e.output_tail.iter().rev().take(PREVIEW_LINES).collect::<Vec<_>>().into_iter().rev() {
                let r = div(m, pv, "tray-preview-line");
                span_text(m, r, "", line);
            }
        } else if !e.last_message.is_empty() {
            let l = div(m, pv, "tray-preview-label");
            span_text(m, l, "", "Output");
            let r = div(m, pv, "tray-preview-line");
            span_text(m, r, "", &e.last_message);
        } else if let Some(msg) = messages.get(e.msg_idx) {
            if msg.kind == MsgKind::Tool {
                if let Some(out) = &msg.tool_output {
                    let tail: Vec<&str> = out
                        .lines()
                        .rev()
                        .take(PREVIEW_LINES)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    if !tail.is_empty() {
                        let l = div(m, pv, "tray-preview-label");
                        span_text(m, l, "", "Output");
                        for line in tail {
                            let r = div(m, pv, "tray-preview-line");
                            span_text(m, r, "", line);
                        }
                    }
                }
            }
        }
        let hint = div(m, pv, "tray-preview-hint");
        let steer = if e.steer_target.is_some() {
            " · s steer · v watch"
        } else {
            ""
        };
        span_text(
            m,
            hint,
            "",
            &format!(
                "{}{steer}",
                if e.foregrounded {
                    "enter view · x kill · f background"
                } else {
                    "enter view · x kill · f foreground"
                },
            ),
        );
    }
}

fn todo_label(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "Pending",
        TodoStatus::InProgress => "In progress",
        TodoStatus::Blocked => "Blocked",
        TodoStatus::Completed => "Completed",
    }
}

/// Todos tab — cockpit `TodoOverlay` list parity: every item (the strip
/// truncates at 6), status-ordered, with a preview of the selection.
fn render_todos(
    m: &mut DocumentMutator<'_>,
    panel: NodeId,
    tray: &TrayState,
    todos: &[TodoItem],
    mode: GlyphMode,
) {
    if todos.is_empty() {
        let e = div(m, panel, "tray-empty");
        span_text(m, e, "", "No todos yet.");
        let s = div(m, panel, "tray-empty-sub");
        span_text(m, s, "", "Todos appear when the todo tool updates the list.");
        return;
    }

    // Same ordering as the strip: status rank, then numeric id suffix.
    let mut ordered: Vec<&TodoItem> = todos.iter().collect();
    ordered.sort_by(|a, b| {
        todo::status_rank(a.status)
            .cmp(&todo::status_rank(b.status))
            .then(todo::id_order(&a.id).cmp(&todo::id_order(&b.id)))
            .then(a.id.cmp(&b.id))
    });

    let split = div(m, panel, "tray-split");
    let list = div(m, split, "tray-list");
    for (row, it) in ordered.iter().enumerate() {
        let item = div(
            m,
            list,
            if row == tray.cursor {
                "tray-item selected"
            } else {
                "tray-item"
            },
        );
        m.set_attribute(item, qual("data-hit-tray"), &row.to_string());
        let (g, class) = todo::glyph(mode, it.status);
        let st = div(m, item, "tray-status");
        span_text(m, st, class, g);
        let name = div(m, item, "tray-name");
        span_text(m, name, "", &format!(" {}", it.subject));
        let meta = div(m, item, "tray-meta");
        span_text(m, meta, "", &format!("  {}", todo_label(it.status)));
    }

    if let Some(it) = ordered.get(tray.cursor) {
        let pv = div(m, split, "tray-preview");
        let t = div(m, pv, "tray-preview-title");
        span_text(m, t, "", &it.subject);
        let meta = div(m, pv, "tray-preview-meta");
        span_text(m, meta, "", &format!("{} · {}", it.id, todo_label(it.status)));
        let hint = div(m, pv, "tray-preview-hint");
        span_text(m, hint, "", "↑↓ select · esc close");
    }
}
