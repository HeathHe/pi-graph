//! Perf probe: measures the per-frame cost of the OLD unconditional
//! sync path vs the NEW signature-gated path on a populated DOM.
//! Run with: `cargo test -p pi-graph-fluent-tui --test perf_probe --release -- --nocapture`

use std::time::Instant;

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::Viewport;
use pi_graph_fluent_tui::app;
use pi_graph_fluent_tui::components::{
    completion, dialog, input_box, message_list, spinner, status_line, todo,
};
use pi_graph_fluent_tui::state::{AppState, DialogState, MsgKind};
use pi_graph_fluent_tui::theme::{self, ThemeKind};
use scrollback::{paint_document, PaintContext, Surface};

const W: u16 = 120;
const H: u16 = 40;
const FRAMES: u32 = 200;

struct Fx {
    doc: BaseDocument,
    handles: app::DomHandles,
    state: AppState,
}

impl Fx {
    fn new() -> Self {
        let font_ctx = blitz_dom::build_single_font_ctx(app::TERMINAL_MONO_BYTES);
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(
                W as u32,
                H as u32,
                1.0,
                ThemeKind::Dark.color_scheme(),
            )),
            font_ctx: Some(font_ctx),
            ua_stylesheets: None,
            ..Default::default()
        });
        doc.add_user_agent_stylesheet(&theme::stylesheet(ThemeKind::Dark));
        let handles = app::build_skeleton(&mut doc);

        let mut state = AppState::new();
        state.status.model = "gpt-5.6-sol".into();
        state.status.thinking = "high".into();
        state.push_user("explain the render pipeline");
        // ~150 messages: a long scrollback where most bubbles are
        // off-screen — exercises the paint subtree culling.
        for i in 0..75 {
            state.push(pi_graph_fluent_tui::state::Message::new(
                MsgKind::Assistant,
                format!(
                    "## Section {i}\n\nSome **bold** and `code` text with a [link](https://x.dev).\n\n- item one\n- item two\n- item three"
                ),
            ));
            let mut t = pi_graph_fluent_tui::state::Message::new(MsgKind::Tool, "cargo test");
            t.tool_name = Some("bash".into());
            t.tool_status = Some('✓');
            t.tool_output = Some(
                (0..12)
                    .map(|j| format!("test case_{i}_{j} ... ok"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
            t.sealed = true;
            state.push(t);
        }
        state.input.text = "next prompt".into();
        state.input.cursor = 5;
        Fx {
            doc,
            handles,
            state,
        }
    }

    fn paint(&mut self) -> Surface {
        let mut surface = Surface::new(W, H);
        {
            let mut ctx = PaintContext::new(&self.doc, &mut surface);
            paint_document(&mut ctx);
        }
        surface
    }

    /// OLD path: every component syncs unconditionally, then resolve.
    fn frame_old(&mut self) -> Surface {
        {
            let mut m = self.doc.mutate();
            message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
            input_box::sync(
                &mut m,
                self.handles.input_hint_text,
                self.handles.input_text,
                &self.state.input,
                self.state.dialog.is_none(),
                "",
            );
            let (bg, ssh) = self.state.tray.running_shells();
            status_line::sync(
                &mut m,
                &self.handles.status,
                &self.state.status,
                self.state.streaming,
                self.state.permission,
                self.state.queued.len(),
                bg,
                ssh,
                self.state.tray.running_subagent(),
                self.state.glyphs,
            );
            let spinner_label = if self.state.aborting {
                "Interrupting".to_string()
            } else {
                match self.state.run_started {
                    Some(t) => format!("Thinking {}s", t.elapsed().as_secs()),
                    None => "Thinking".to_string(),
                }
            };
            spinner::sync(
                &mut m,
                &self.handles.spinner,
                self.state.streaming || self.state.aborting,
                self.state.tick,
                &spinner_label,
                if self.state.aborting { "" } else { "esc to interrupt" },
                self.state.glyphs,
                &theme::Theme::new(ThemeKind::Dark).fusion(),
            );
            dialog::sync(
                &mut m,
                self.handles.dialog_area,
                self.handles.widget_area,
                self.handles.queue_area,
                &self.state,
                self.state.glyphs,
            );
            todo::sync(
                &mut m,
                self.handles.todo_area,
                &self.state,
                self.state.glyphs,
            );
            completion::sync(
                &mut m,
                self.handles.completion_area,
                &self.state,
                self.state.glyphs,
            );
            m.set_style_property(self.handles.app, "width", &format!("{W}px"));
            m.set_style_property(self.handles.app, "height", &format!("{H}px"));
        }
        self.doc.set_viewport(Viewport::new(
            W as u32,
            H as u32,
            1.0,
            ThemeKind::Dark.color_scheme(),
        ));
        self.doc.resolve(0.0);
        message_list::apply_scroll(
            &mut self.doc,
            self.handles.messages,
            self.handles.scrollbar_thumb,
            &mut self.state,
        );
        self.paint()
    }

    /// NEW path on an unchanged frame: signature checks only (the
    /// app's stored sigs match), no syncs, no resolve — then paint.
    fn frame_new(&mut self) -> Surface {
        let _sigs = (
            dialog::signature(&self.state),
            completion::signature(&self.state),
        );
        if self.state.dom_dirty {
            let mut m = self.doc.mutate();
            message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
            drop(m);
            self.state.dom_dirty = false;
            self.doc.resolve(0.0);
        }
        message_list::apply_scroll(
            &mut self.doc,
            self.handles.messages,
            self.handles.scrollbar_thumb,
            &mut self.state,
        );
        self.paint()
    }
}

#[test]
fn perf_probe_idle_frame() {
    let mut f = Fx::new();
    // Warm up: one full old-path frame to populate the DOM.
    let _ = f.frame_old();
    f.state.dom_dirty = false;

    // Sanity: identical output between paths on a static frame.
    let old_text = f.frame_old().to_text();
    let new_text = f.frame_new().to_text();
    assert_eq!(old_text, new_text, "static frame output must match");

    let t0 = Instant::now();
    for _ in 0..FRAMES {
        let _ = f.frame_old();
    }
    let old_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t0 = Instant::now();
    for _ in 0..FRAMES {
        let _ = f.frame_new();
    }
    let new_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // Isolated paint cost on the big DOM (subtree culling active).
    let t0 = Instant::now();
    for _ in 0..FRAMES {
        let _ = f.paint();
    }
    let paint_ms = t0.elapsed().as_secs_f64() * 1000.0;
    eprintln!(
        "[perf] paint-only ({} msgs): {:.3}ms/frame",
        f.state.messages.len(),
        paint_ms / FRAMES as f64
    );

    eprintln!(
        "[perf] idle frame ({}x{}, {} msgs): old {:.2}ms → new {:.2}ms ({:.1}x)",
        W,
        H,
        f.state.messages.len(),
        old_ms / FRAMES as f64,
        new_ms / FRAMES as f64,
        old_ms / new_ms.max(0.001),
    );
}

#[test]
fn perf_probe_dialog_open_frame() {
    let mut f = Fx::new();
    let _ = f.frame_old();
    f.state.dom_dirty = false;
    f.state.dialog = Some(DialogState::Select {
        id: "m".into(),
        sel: pi_graph_fluent_tui::components::select::SelectState::new(
            "Pick a model",
            (0..30).map(|i| format!("model-{i}")).collect(),
        ),
    });

    let t0 = Instant::now();
    for _ in 0..FRAMES {
        let _ = f.frame_old();
    }
    let old_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // New path with a *stable* dialog signature: rebuild once, then skip.
    let mut last_sig = 0u64;
    let t0 = Instant::now();
    for _ in 0..FRAMES {
        let sig = dialog::signature(&f.state);
        if sig != last_sig {
            let mut m = f.doc.mutate();
            dialog::sync(
                &mut m,
                f.handles.dialog_area,
                f.handles.widget_area,
                f.handles.queue_area,
                &f.state,
                f.state.glyphs,
            );
            drop(m);
            f.doc.resolve(0.0);
            last_sig = sig;
        }
        message_list::apply_scroll(
            &mut f.doc,
            f.handles.messages,
            f.handles.scrollbar_thumb,
            &mut f.state,
        );
        let _ = f.paint();
    }
    let new_ms = t0.elapsed().as_secs_f64() * 1000.0;

    eprintln!(
        "[perf] dialog-open frame: old {:.2}ms → new {:.2}ms ({:.1}x)",
        old_ms / FRAMES as f64,
        new_ms / FRAMES as f64,
        old_ms / new_ms.max(0.001),
    );
}
