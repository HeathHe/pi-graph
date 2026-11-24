//! `app` — the Devin-style event loop (`App::run` / `render_frame`).
//!
//! ```text
//! loop {
//!   tokio::select! { rpc_event, terminal input (crossterm), tick }
//!     → update AppState → patch DOM (DocumentMutator)
//!   render_frame:
//!     terminal::size → set_viewport → resolve() → apply_scroll
//!     → scrollback::paint_document → Renderer::draw → stdout ANSI
//! }
//! ```
//!
//! Resize is implicit (size cached from crossterm Resize events; the
//! `Renderer` forces a full redraw on size change). Frames are wrapped in
//! synchronized-output markers `?2026h`/`?2026l`; alt-screen `?1049h`/`?1049l`
//! brackets the run.

use std::io::{self, Write};
use std::sync::Arc;
use std::time::{Duration, Instant};

use blitz_dom::{BaseDocument, DocumentConfig};
use blitz_traits::shell::Viewport;
use crossterm::event::{
    DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
    Event as TermEvent, EventStream as TermEventStream, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseEventKind,
};
use crossterm::{execute, terminal};
use futures_util::StreamExt;
use pi_rpc::{AgentEvent, PiRpc, RpcCommand, RpcEvent, RpcResponse, StreamingBehavior};
use scrollback::{ansi, paint_document, Frame, PaintContext, Renderer, Surface};
use tokio::sync::mpsc;

use crate::commands::{self, Command, LocalCmd};
use crate::components::{
    completion, dialog, input_box, message_list, select, selection, spinner, status_line, todo,
};
use crate::state::{
    agent_message_text, AppState, DialogState, LocalAction, MsgKind, ResponseEffect,
};
use crate::theme::{self, Theme, ThemeKind};

/// Embedded TerminalMono metrics font (advance == upm → 1px = 1 cell).
pub const TERMINAL_MONO_BYTES: &[u8] = include_bytes!("../assets/TerminalMono.ttf");

/// Frame tick rate (also the max streaming repaint cadence).
const TICK: Duration = Duration::from_millis(33);

/// DOM node ids the app keeps for incremental updates.
pub struct DomHandles {
    #[allow(dead_code)]
    pub root: blitz_dom::NodeId,
    pub app: blitz_dom::NodeId,
    pub messages: blitz_dom::NodeId,
    pub messages_inner: blitz_dom::NodeId,
    /// `#scrollbar` thumb element (geometry synced in `apply_scroll`).
    pub scrollbar_thumb: blitz_dom::NodeId,
    /// `.messages-wrap` row (hidden while the trace overlay is open).
    pub messages_wrap: blitz_dom::NodeId,
    /// `#trace` full-viewport thinking overlay (hidden unless open).
    pub trace: blitz_dom::NodeId,
    /// The single text node inside `#trace`.
    pub trace_text: blitz_dom::NodeId,
    pub spinner: spinner::SpinnerHandles,
    /// `#queue-area` — queued follow-ups between the working status
    /// line and the input (top border separates it from the status).
    pub queue_area: blitz_dom::NodeId,
    /// `#todo-area` — persistent todo strip below the queue area.
    pub todo_area: blitz_dom::NodeId,
    pub dialog_area: blitz_dom::NodeId,
    pub widget_area: blitz_dom::NodeId,
    pub input_hint_text: blitz_dom::NodeId,
    pub input_text: blitz_dom::NodeId,
    /// In-flow completion list below the input (native pi style).
    pub completion_area: blitz_dom::NodeId,
    pub status: status_line::StatusLineHandles,
}

/// The TUI application.
pub struct App {
    rpc: Arc<PiRpc>,
    doc: BaseDocument,
    handles: DomHandles,
    state: AppState,
    renderer: Renderer,
    theme: Theme,
    theme_kind: ThemeKind,
    /// The active UA stylesheet text — kept so `apply_theme` can
    /// `remove_user_agent_stylesheet` before adding the next one
    /// (blitz-dom appends; stale sheets would otherwise accumulate).
    theme_css: String,
    /// Height of the `#messages` viewport from the last frame (for
    /// PageUp/PageDown scroll math).
    messages_view_h: u32,
    /// Rendered state of the thinking-trace overlay (mirrors
    /// `state.trace_open` after the display swap is applied).
    trace_open: bool,
    /// Outbound command results / async notices.
    notice_rx: mpsc::UnboundedReceiver<String>,
    notice_tx: mpsc::UnboundedSender<String>,
    /// Full `RpcResponse`s from `send_report` (slash-command dispatch).
    cmd_rx: mpsc::UnboundedReceiver<RpcResponse>,
    cmd_tx: mpsc::UnboundedSender<RpcResponse>,
    /// `data-hit-*` regions recorded by the last paint (mouse routing).
    hit_regions: Vec<scrollback::HitRegion>,
    /// Left-button press cell — click-vs-drag discrimination. The click
    /// dispatch is deferred to `Up` so a drag becomes a selection.
    mouse_down: Option<(u16, u16)>,
    /// Hit region under `mouse_down` (reused by the `Up` click).
    down_hit: Option<scrollback::HitRegion>,
    /// Selection signature — `(anchor, head)` hash gates repaints of
    /// the INVERSE post-pass without touching DOM sync.
    sel_sig: u64,
    /// Last Esc press — a second Esc within `ESC_INTERRUPT_WINDOW`
    /// while streaming sends `abort` (Devin: "esc twice to interrupt").
    last_esc: Option<Instant>,
    /// Cached terminal size — `terminal::size()` is an ioctl; only
    /// re-read on crossterm Resize events.
    term_size: (u16, u16),
    /// Last viewport pushed to the doc — `set_viewport` rebuilds the
    /// stylo Device + re-evaluates media queries, so skip when same.
    last_viewport: (u16, u16),
    /// Signatures of the per-frame component syncs — skip rebuilds
    /// when their inputs haven't changed.
    dialog_sig: u64,
    completion_sig: u64,
    todo_sig: u64,
    /// Signatures of the text-mutating syncs — decide whether
    /// `doc.resolve` is needed at all this frame.
    input_sig: u64,
    spinner_sig: u64,
    status_sig: u64,
    /// Reusable surface buffer (double-buffered with the renderer's
    /// previous frame).
    surface_spare: Option<Surface>,
    /// Scroll offset written into the DOM by the last painted frame —
    /// a scroll-only change repaints without a resolve.
    painted_scroll: u32,
}

/// Double-Esc interrupt window.
const ESC_INTERRUPT_WINDOW: Duration = Duration::from_millis(800);

/// Select the RPC command used for text submitted during an active turn.
/// The `set_*_mode` RPCs configure queue drain policy (`all` vs
/// `one-at-a-time`); choosing steer vs follow-up is done by the command
/// variant itself.
fn streaming_input_command(
    mode: Option<StreamingBehavior>,
    message: String,
    images: Option<Vec<pi_rpc::MessageContent>>,
) -> RpcCommand {
    match mode.unwrap_or(StreamingBehavior::FollowUp) {
        StreamingBehavior::Steer => RpcCommand::Steer { message, images },
        StreamingBehavior::FollowUp => RpcCommand::FollowUp { message, images },
    }
}

/// Command that cancels a running tray entry, plus an optional user note.
/// Shells abort their own process; teammate rows carry a `steer_target`
/// (correlationId) and route `/teammate-abort <target>` so only that agent
/// is terminated — extension commands execute via `prompt` even mid-stream.
/// Subagent rows without a target fall back to the session-wide abort.
pub fn tray_cancel_command(
    kind: crate::state::TrayKind,
    steer_target: Option<String>,
    streaming: bool,
) -> Option<(RpcCommand, String)> {
    match kind {
        crate::state::TrayKind::Shell => Some((RpcCommand::AbortBash, String::new())),
        crate::state::TrayKind::Subagent => match steer_target {
            Some(target) => Some((
                RpcCommand::Prompt {
                    message: format!("/teammate-abort {target}"),
                    images: None,
                    streaming_behavior: None,
                },
                format!("abort → {target}"),
            )),
            None if streaming => Some((
                RpcCommand::Abort,
                "abort sent (cancels the whole run)".into(),
            )),
            None => None,
        },
    }
}

impl App {
    /// Build the app: document, DOM skeleton, renderer, RPC handle.
    pub fn new(rpc: PiRpc, theme_kind: ThemeKind) -> Self {
        let font_ctx = blitz_dom::build_single_font_ctx(TERMINAL_MONO_BYTES);
        let (w, h) = terminal::size().unwrap_or((80, 24));
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(
                w as u32,
                h as u32,
                1.0,
                theme_kind.color_scheme(),
            )),
            font_ctx: Some(font_ctx),
            // `None` keeps blitz's DEFAULT_CSS; our sheet is added on top.
            ua_stylesheets: None,
            ..Default::default()
        });
        let theme_css = theme::stylesheet(theme_kind);
        doc.add_user_agent_stylesheet(&theme_css);

        let handles = build_skeleton(&mut doc);

        let (notice_tx, notice_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        App {
            rpc: Arc::new(rpc),
            doc,
            handles,
            state: AppState::new(),
            renderer: Renderer::new(),
            theme: Theme::new(theme_kind),
            theme_kind,
            theme_css,
            messages_view_h: 0,
            notice_rx,
            notice_tx,
            cmd_rx,
            cmd_tx,
            hit_regions: Vec::new(),
            mouse_down: None,
            down_hit: None,
            sel_sig: u64::MAX,
            last_esc: None,
            term_size: (w, h),
            last_viewport: (0, 0),
            dialog_sig: u64::MAX,
            completion_sig: u64::MAX,
            todo_sig: u64::MAX,
            input_sig: u64::MAX,
            spinner_sig: u64::MAX,
            status_sig: u64::MAX,
            surface_spare: None,
            painted_scroll: 0,
            trace_open: false,
        }
    }

    /// Signature of the input-line inputs — hashes what `hint_for`
    /// and `input_box::sync` render, so the hint String itself is only
    /// built when the signature actually changed.
    fn input_signature(state: &AppState) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.input.text.hash(&mut s);
        state.input.cursor.hash(&mut s);
        state.attachments.len().hash(&mut s);
        for a in &state.attachments {
            a.label.hash(&mut s);
        }
        state.attachment_sel.hash(&mut s);
        state.tip_idx.hash(&mut s);
        state.show_tips().hash(&mut s);
        state
            .settings
            .get("show_cwd_in_input_border")
            .copied()
            .unwrap_or(true)
            .hash(&mut s);
        state.dialog.is_some().hash(&mut s);
        s.finish()
    }

    /// Signature of the spinner inputs (active/frame/hint).
    /// `tick` itself isn't hashed — only the derived frame, so an
    /// idle tick doesn't force a resolve.
    fn spinner_signature(state: &AppState) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.streaming.hash(&mut s);
        state.aborting.hash(&mut s);
        if state.streaming || state.aborting {
            (state.tick / spinner::SPINNER_FRAME_TICKS).hash(&mut s); // glyph frame
        }
        s.finish()
    }

    /// Signature of the status-line inputs.
    fn status_signature(state: &AppState) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        state.status.model.hash(&mut s);
        state.status.thinking.hash(&mut s);
        state.status.mode.hash(&mut s);
        state.status.transient.hash(&mut s);
        state.status.input_tokens.hash(&mut s);
        state.status.output_tokens.hash(&mut s);
        state.status.context_tokens.hash(&mut s);
        state.status.context_window.hash(&mut s);
        state.status.cost.to_bits().hash(&mut s);
        state.status.cwd.hash(&mut s);
        state.status.git_branch.hash(&mut s);
        state.streaming.hash(&mut s);
        state.permission.label().hash(&mut s);
        state.queued.len().hash(&mut s);
        state.tray.running_shells().hash(&mut s);
        state.tray.running_subagent().hash(&mut s);
        s.finish()
    }

    /// Detect the terminal's ANSI color level and publish it on the
    /// renderer's shared cell.
    fn detect_level(&mut self) {
        let level = if std::env::var("NO_COLOR").is_ok() {
            scrollback::Level::NONE
        } else {
            match std::env::var("COLORTERM").ok().as_deref() {
                Some("truecolor") | Some("24bit") => scrollback::Level::TRUECOLOR,
                _ => match std::env::var("TERM").ok().as_deref() {
                    Some(t) if t.contains("256color") => scrollback::Level::ANSI256,
                    Some("dumb") => scrollback::Level::NONE,
                    _ => scrollback::Level::TRUECOLOR,
                },
            }
        };
        let _ = self.renderer.level.set(level);
    }

    /// Run the event loop until quit / child exit. Restores the terminal
    /// on the way out.
    pub async fn run(&mut self) -> io::Result<()> {
        self.detect_level();
        terminal_setup_enter()?;

        let result = self.run_inner().await;

        terminal_setup_leave()?;
        result
    }

    async fn run_inner(&mut self) -> io::Result<()> {
        let mut events = self.rpc.events();
        let mut term_events = TermEventStream::new();
        let mut tick = tokio::time::interval(TICK);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // First paint — before any pi round-trip resolves. pi's node
        // boot can take seconds; the UI must not wait on it.
        self.render_frame()?;

        // Initial session state → status line, command list → `/`
        // completion, todos → strip. All fire-and-forget: responses
        // arrive on cmd_rx and land in `handle_cmd_response` once pi
        // finishes booting.
        self.send_report(RpcCommand::GetState);
        self.state.commands_quiet = true;
        self.send_report(RpcCommand::GetCommands);
        self.fetch_todos();

        loop {
            let mut frame_dirty = false;

            tokio::select! {
                // RPC event from the pi child.
                maybe_event = events.next() => {
                    match maybe_event {
                        Some(ev) => {
                            frame_dirty = self.handle_rpc_event(ev);
                        }
                        None => {
                            // Event stream closed → child exited.
                            self.state.push_system("pi process exited");
                            self.state.quit = true;
                            frame_dirty = true;
                        }
                    }
                }
                // Terminal input.
                maybe_term = term_events.next() => {
                    match maybe_term {
                        Some(Ok(ev)) => {
                            frame_dirty = self.handle_term_event(ev);
                        }
                        Some(Err(_)) | None => {
                            self.state.quit = true;
                        }
                    }
                }
                // Async notices (send failures, etc).
                Some(note) = self.notice_rx.recv() => {
                    self.state.push_system(note);
                    frame_dirty = true;
                }
                // Slash-command responses (send_report).
                Some(resp) = self.cmd_rx.recv() => {
                    frame_dirty = self.handle_cmd_response(resp);
                }
                // Frame tick — repaint only when something changed.
                _ = tick.tick() => {
                    if self.state.tick_frame() {
                        frame_dirty = true;
                    }
                }
            }

            if self.state.quit {
                break;
            }
            if frame_dirty || self.state.dom_dirty {
                self.render_frame()?;
            }
        }
        Ok(())
    }

    /// Headless end-to-end check: send `prompt`, pump the event loop until
    /// `agent_end`, then return the final painted surface as text.
    /// Used by `--headless-prompt` (no terminal, no alt-screen).
    pub async fn headless_prompt(&mut self, prompt: &str, w: u16, h: u16) -> String {
        use futures_util::StreamExt;
        let mut events = self.rpc.events();
        self.state.push_user(prompt);
        let cmd = RpcCommand::Prompt {
            message: prompt.to_string(),
            images: None,
            streaming_behavior: None,
        };
        let _ = self.rpc.send(&cmd).await;
        // Pump events until the run ends (or a generous timeout).
        let deadline = tokio::time::Instant::now() + Duration::from_secs(120);
        loop {
            let next = tokio::time::timeout_at(deadline, events.next()).await;
            match next {
                Ok(Some(ev)) => {
                    if std::env::var("TUI_DEBUG_EVENTS").is_ok() {
                        let s = format!("{ev:?}");
                        eprintln!("[ev] {}", &s[..s.len().min(200)]);
                    }
                    self.state.apply_event(&ev);
                    // Headless mode can't show dialogs — auto-cancel any
                    // interactive request so the agent never blocks.
                    if self.state.dialog.is_some() {
                        self.state.cancel_dialog();
                        self.flush_dialog_result();
                    }
                    if self.state.dom_dirty {
                        let _ = self.paint_frame_at(w, h);
                    }
                    if matches!(
                        ev.as_agent(),
                        Some(AgentEvent::AgentEnd { .. } | AgentEvent::AgentSettled)
                    ) {
                        break;
                    }
                }
                Ok(None) => {
                    eprintln!("[ev] stream closed (child exited)");
                    break;
                }
                Err(_) => {
                    eprintln!("[ev] timeout waiting for agent_end");
                    break;
                }
            }
        }
        // Headless dump always wants a surface — force one even when
        // the frame is unchanged (prev_frame is empty anyway).
        match self.paint_frame_at(w, h) {
            Some(s) => s.to_text(),
            None => self
                .renderer
                .prev_frame
                .as_ref()
                .map(|f| f.surface.to_text())
                .unwrap_or_default(),
        }
    }

    /// Reduce one RPC event; returns whether a repaint is needed.
    fn handle_rpc_event(&mut self, ev: RpcEvent) -> bool {
        // Dedup: a locally-echoed user message may arrive as
        // message_start. Check the last few messages — a tool/system
        // line may have landed between the echo and the event.
        if let RpcEvent::Agent(AgentEvent::MessageStart { message }) = &ev {
            if let Some((MsgKind::User, text)) = agent_message_text(message) {
                if self
                    .state
                    .messages
                    .iter()
                    .rev()
                    .take(8)
                    .any(|m| m.kind == MsgKind::User && m.text == text)
                {
                    return false;
                }
            }
        }
        let dirty = self.state.apply_event(&ev);
        // A settled todo call rewrites the durable `todo-state` entry —
        // rehydrate the strip in the background.
        if matches!(
            &ev,
            RpcEvent::Agent(AgentEvent::ToolExecutionEnd { tool_name, .. })
                if tool_name.eq_ignore_ascii_case("todo")
        ) {
            self.fetch_todos();
        }
        // Flush any dialog response queued by the reducer (e.g. a queued
        // request promoted after a resolve).
        self.flush_dialog_result();
        dirty
    }

    /// Send a queued `extension_ui_response` to pi (fire-and-forget).
    fn flush_dialog_result(&mut self) {
        if let Some(resp) = self.state.dialog_result.take() {
            let rpc = Arc::clone(&self.rpc);
            let tx = self.notice_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = rpc.respond_ui(&resp).await {
                    let _ = tx.send(format!("respond_ui failed: {e}"));
                }
            });
        }
    }

    /// Forward one UI event to the plugin that owns overlay request `id`.
    fn send_ui_event(&self, id: &str, event: pi_rpc::UiEvent) {
        let line = pi_rpc::RpcExtensionUIEvent {
            id: id.to_string(),
            event,
        }
        .to_wire_value()
        .to_string();
        let rpc = Arc::clone(&self.rpc);
        let tx = self.notice_tx.clone();
        tokio::spawn(async move {
            if let Err(e) = rpc.send_raw(&line).await {
                let _ = tx.send(format!("ui event failed: {e}"));
            }
        });
    }

    /// Reduce one terminal event; returns whether a repaint is needed.
    fn handle_term_event(&mut self, ev: TermEvent) -> bool {
        let dirty = match ev {
            TermEvent::Key(key) => {
                let dirty = self.handle_key(key);
                // `handle_key` checks the popup before applying the key so
                // navigation/acceptance can shadow editor bindings. Rebuild
                // it once more after the edit so the trigger character
                // itself (`/` or `@`) opens completion immediately.
                // Escape is an explicit close and must not reopen it from
                // the unchanged input text.
                if key.code != KeyCode::Esc {
                    self.refresh_completion();
                }
                dirty
            }
            TermEvent::Paste(s) => {
                let s = s.replace("\r\n", "\n").replace('\r', "\n");
                match &mut self.state.dialog {
                    Some(DialogState::Input { input, .. })
                    | Some(DialogState::Editor { input, .. }) => input.insert_str(&s),
                    _ => self.state.input.insert_str(&s),
                }
                self.refresh_completion();
                true
            }
            TermEvent::Mouse(m) => self.handle_mouse(m),
            TermEvent::Resize(w, h) => {
                self.term_size = (w, h);
                // Plugin-driven overlays re-render at the new budget.
                if let Some(DialogState::Plugin {
                    id,
                    driver: pi_rpc::OverlayDriver::Plugin,
                    ..
                }) = &self.state.dialog
                {
                    let id = id.clone();
                    self.send_ui_event(
                        &id,
                        pi_rpc::UiEvent::Resize {
                            w: u32::from(w),
                            h: u32::from(h),
                        },
                    );
                }
                true
            }
            _ => false,
        };
        // A dialog key/click may have queued a response.
        self.flush_dialog_result();
        dirty
    }

    /// Recompute input completion after a terminal edit or paste.
    fn refresh_completion(&mut self) {
        if self.state.dialog.is_some() || self.state.tray.open || self.state.search.is_some() {
            self.state.completion = None;
            return;
        }
        if self.state.file_index.is_none()
            && self.state.input.text[..self.state.input.cursor].contains('@')
        {
            self.state.file_index = Some(build_file_index(&self.state));
        }
        self.state.update_completion();
    }

    /// Route a mouse event through the painted `data-hit-*` regions.
    ///
    /// Click dispatch is deferred from `Down` to `Up`: a `Drag` between
    /// them turns the gesture into a text selection (INVERSE post-pass)
    /// instead of a click. `Right` copies the standing selection.
    fn handle_mouse(&mut self, m: crossterm::event::MouseEvent) -> bool {
        let (col, row) = (m.column as i32, m.row as i32);
        let hit = self
            .hit_regions
            .iter()
            .rev() // topmost (last painted) wins
            .find(|r| {
                col >= r.rect.x
                    && col < r.rect.x + r.rect.w
                    && row >= r.rect.y
                    && row < r.rect.y + r.rect.h
            })
            .cloned();
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
                self.state.clear_selection();
                let up = m.kind == MouseEventKind::ScrollUp;
                match hit.as_ref().map(|r| r.kind.as_str()) {
                    // Wheel over the select dropdown moves its cursor.
                    Some("idx") | Some("option") => {
                        let sel = match &mut self.state.dialog {
                            Some(DialogState::Select { sel, .. })
                            | Some(DialogState::Local { sel, .. }) => Some(sel),
                            _ => None,
                        };
                        if let Some(sel) = sel {
                            if up {
                                sel.move_up();
                            } else {
                                sel.move_down();
                            }
                            self.state.dom_dirty = true;
                        }
                        true
                    }
                    _ => {
                        self.scroll_messages(if up { -3 } else { 3 });
                        true
                    }
                }
            }
            MouseEventKind::Down(crossterm::event::MouseButton::Left) => {
                self.mouse_down = Some((m.column, m.row));
                self.down_hit = hit;
                // A new press replaces any standing selection.
                self.state.clear_selection();
                true
            }
            MouseEventKind::Drag(crossterm::event::MouseButton::Left) => {
                let Some(anchor) = self.mouse_down else {
                    return false;
                };
                self.state.sel_anchor.get_or_insert(anchor);
                self.state.sel_head = Some((m.column, m.row));
                true
            }
            MouseEventKind::Up(crossterm::event::MouseButton::Left) => {
                let down = self.mouse_down.take();
                let dhit = self.down_hit.take();
                // A real drag leaves a selection standing — no click.
                if let (Some(a), Some(b)) = (self.state.sel_anchor, self.state.sel_head) {
                    if a != b {
                        return true;
                    }
                }
                self.state.clear_selection();
                match (down, dhit) {
                    (Some(_), Some(hit)) => self.click_hit(&hit),
                    _ => false,
                }
            }
            // Right-click copies the standing selection to the clipboard.
            MouseEventKind::Down(crossterm::event::MouseButton::Right) => {
                if self.state.sel_text.is_empty() {
                    return false;
                }
                let n = self.state.sel_text.chars().count();
                match copy_to_clipboard(&self.state.sel_text) {
                    Ok(()) => self.state.push_system(format!("copied {n} chars")),
                    Err(e) => self.state.push_system(format!("clipboard: {e}")),
                }
                self.state.clear_selection();
                true
            }
            _ => false,
        }
    }

    /// Left-click dispatch — runs on `Up` once the gesture is known to
    /// be a click, not a drag.
    fn click_hit(&mut self, hit: &scrollback::HitRegion) -> bool {
        match hit.kind.as_str() {
                    // Select option: click moves the cursor; clicking the
                    // already-selected row submits it. With no dialog,
                    // `idx` rows belong to the `/` completion popup.
                    "idx" => {
                        let i = hit.payload.as_deref().unwrap_or("").parse::<usize>().ok();
                        if self.state.dialog.is_none() && self.state.completion.is_some() {
                            if let Some(i) = i {
                                if let Some(c) = &mut self.state.completion {
                                    c.cursor = i.min(c.items.len() - 1);
                                }
                                self.state.accept_completion();
                            }
                            return true;
                        }
                        match &mut self.state.dialog {
                            Some(DialogState::Select { id, sel }) => {
                                if let Some(i) = i {
                                    let was = sel.cursor;
                                    sel.click(i);
                                    if sel.cursor == was {
                                        if let Some(value) = sel.selected_label() {
                                            let id = id.clone();
                                            self.state.resolve_dialog(
                                                pi_rpc::RpcExtensionUIResponse::Value { id, value },
                                            );
                                        }
                                    }
                                }
                                self.state.dom_dirty = true;
                            }
                            Some(DialogState::Local { sel, action }) => {
                                let mut preview = false;
                                if let Some(i) = i {
                                    let was = sel.cursor;
                                    sel.click(i);
                                    if sel.cursor == was {
                                        // Clicked the already-selected row → submit.
                                        let action = *action;
                                        if let Some(idx) = sel.selected() {
                                            self.state.dialog = None;
                                            self.dispatch_local_select(action, idx);
                                        }
                                    } else {
                                        preview = *action == LocalAction::SetTheme;
                                    }
                                }
                                self.state.dom_dirty = true;
                                if preview {
                                    self.preview_theme_selection();
                                }
                            }
                            _ => {}
                        }
                        true
                    }
                    // Confirm buttons: yes / no / cancel.
                    "confirm" => {
                        let id = self
                            .state
                            .dialog
                            .as_ref()
                            .map(|d| d.id().to_string())
                            .unwrap_or_default();
                        match hit.payload.as_deref() {
                            Some("yes") => self.state.resolve_dialog(
                                pi_rpc::RpcExtensionUIResponse::Confirmed {
                                    id,
                                    confirmed: true,
                                },
                            ),
                            Some("no") => self.state.resolve_dialog(
                                pi_rpc::RpcExtensionUIResponse::Confirmed {
                                    id,
                                    confirmed: false,
                                },
                            ),
                            _ => self.state.cancel_dialog(),
                        }
                        true
                    }
                    // Truncation marker: expand/collapse that tool card.
                    "expand" => {
                        self.state.toggle_tool_by_node(hit.node);
                        true
                    }
                    // Tray row click: move the cursor to that row.
                    "tray" => {
                        if let Some(row) = hit.payload.as_deref().and_then(|p| p.parse().ok()) {
                            if row < self.state.tray.rows(self.state.todos.len()) {
                                self.state.tray.cursor = row;
                                self.state.dom_dirty = true;
                            }
                        }
                        true
                    }
                    // Link: open in the system browser.
                    "link" => {
                        if let Some(url) = &hit.payload {
                            open_url(url);
                        }
                        true
                    }
                    _ => false,
        }
    }

    fn handle_key(&mut self, key: KeyEvent) -> bool {
        // Only act on presses (Windows emits release events too).
        if key.kind == KeyEventKind::Release {
            return false;
        }
        // Any key drops the standing mouse selection.
        if self.state.sel_anchor.is_some() {
            self.state.clear_selection();
        }
        // Dialogs capture all keys while active.
        if self.state.dialog.is_some() {
            return self.handle_dialog_key(key);
        }
        // Thinking-trace overlay (Alt+T) is modal while open.
        if self.state.trace_open {
            return self.handle_trace_key(key);
        }
        // Scrollback search (Ctrl+S) is modal like the tray.
        if self.state.search.is_some() {
            return self.handle_search_key(key);
        }
        // The tray panel captures keys while open (F2 toggles).
        if self.state.tray.open {
            return self.handle_tray_key(key);
        }
        // Attachment selection context (RECON §12.4: left/right/exit).
        // Once a chip is selected these keys edit the selection until
        // Esc/any other key exits back to the editor.
        if let Some(sel) = self.state.attachment_sel {
            let n = self.state.attachments.len();
            match key.code {
                KeyCode::Left => {
                    self.state.attachment_sel = Some(sel.saturating_sub(1));
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Right => {
                    self.state.attachment_sel = Some((sel + 1).min(n - 1));
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Backspace | KeyCode::Delete => {
                    self.state.attachments.remove(sel.min(n - 1));
                    self.state.attachment_sel = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Esc => {
                    self.state.attachment_sel = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                _ => {
                    // Any other key exits selection, then falls through.
                    self.state.attachment_sel = None;
                }
            }
        }
        // `/`/`@` completion popup: recompute from the input as of the
        // previous key, then let it shadow nav/accept keys.
        if self.state.file_index.is_none()
            && self.state.input.text[..self.state.input.cursor].contains('@')
        {
            self.state.file_index = Some(build_file_index(&self.state));
        }
        self.state.update_completion();
        if self.state.completion.is_some() {
            match key.code {
                KeyCode::Up => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Down => {
                    if let Some(c) = &mut self.state.completion {
                        c.next();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                // Native pi: tab/shift+tab cycle, enter accepts.
                KeyCode::Tab if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::BackTab => {
                    if let Some(c) = &mut self.state.completion {
                        c.prev();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Tab => {
                    if let Some(c) = &mut self.state.completion {
                        c.next();
                    }
                    self.state.dom_dirty = true;
                    return true;
                }
                KeyCode::Enter => {
                    self.state.accept_completion();
                    return true;
                }
                KeyCode::Esc => {
                    self.state.completion = None;
                    self.state.dom_dirty = true;
                    return true;
                }
                _ => {}
            }
        }
        // Any non-Esc key breaks the esc-twice interrupt window.
        if key.code != KeyCode::Esc {
            self.last_esc = None;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        // F2: open the subagent tray (backgrounds the foreground view).
        if key.code == KeyCode::F(2) {
            if self
                .state
                .settings
                .get("subagents_enabled")
                .copied()
                .unwrap_or(true)
            {
                self.state.tray.open = true;
                self.state.dom_dirty = true;
            } else {
                self.state
                    .push_system("subagent tray disabled in /settings");
            }
            return true;
        }
        // Alt (Meta) bindings — the Emacs word ops.
        if alt {
            match key.code {
                KeyCode::Char('b') | KeyCode::Char('B') => {
                    self.state.input.move_word_left();
                    return true;
                }
                KeyCode::Char('f') | KeyCode::Char('F') => {
                    self.state.input.move_word_right();
                    return true;
                }
                KeyCode::Char('d') | KeyCode::Char('D') => {
                    self.state.input.kill_word();
                    return true;
                }
                KeyCode::Char('u') | KeyCode::Char('U') => {
                    self.state.input.case_word(crate::state::WordCase::Upper);
                    return true;
                }
                KeyCode::Char('l') | KeyCode::Char('L') => {
                    self.state.input.case_word(crate::state::WordCase::Lower);
                    return true;
                }
                KeyCode::Char('c') | KeyCode::Char('C') => {
                    self.state
                        .input
                        .case_word(crate::state::WordCase::Capitalize);
                    return true;
                }
                KeyCode::Char('t') | KeyCode::Char('T') => {
                    self.state.input.transpose_words();
                    return true;
                }
                KeyCode::Char('y') | KeyCode::Char('Y') => {
                    self.state.input.yank_pop();
                    return true;
                }
                KeyCode::Backspace => {
                    self.state.input.backward_kill_word();
                    return true;
                }
                // Alt+S: choose whether Enter steers the active turn or
                // queues a follow-up. This is separate from pi's queue
                // drain policy (`all` vs `one-at-a-time`).
                KeyCode::Char('s') | KeyCode::Char('S') => {
                    let next = match self
                        .state
                        .steering_mode
                        .unwrap_or(StreamingBehavior::FollowUp)
                    {
                        StreamingBehavior::FollowUp => StreamingBehavior::Steer,
                        StreamingBehavior::Steer => StreamingBehavior::FollowUp,
                    };
                    self.state.steering_mode = Some(next);
                    self.state.status.mode = match next {
                        StreamingBehavior::Steer => "send:steer",
                        StreamingBehavior::FollowUp => "send:follow-up",
                    }
                    .to_string();
                    self.state.dom_dirty = true;
                    return true;
                }
                // Unknown Alt+Char still inserts (macOS Option typing).
                KeyCode::Char(c) => {
                    self.state.input.insert_char(c);
                    return true;
                }
                _ => return false,
            }
        }
        match (key.code, ctrl, shift) {
            (KeyCode::Char('z') | KeyCode::Char('Z'), true, true) => {
                self.state.input.redo();
                true
            }
            (KeyCode::Char('z') | KeyCode::Char('Z'), true, false)
            | (KeyCode::Char('_'), true, _) => {
                self.state.input.undo();
                true
            }
            (KeyCode::Char('c'), true, _) => {
                if self.state.streaming {
                    self.send_cmd(RpcCommand::Abort);
                } else {
                    self.state.quit = true;
                }
                true
            }
            // Shift+Tab: cycle permission modes.
            (KeyCode::BackTab, _, _) => {
                self.state.permission = self.state.permission.next();
                self.state.dom_dirty = true;
                true
            }
            // Ctrl+B: run the input as a background bash command.
            (KeyCode::Char('b'), true, _) => {
                let cmd = self.state.input.take_submitted();
                if cmd.trim().is_empty() {
                    self.state
                        .push_system("Ctrl+B: type a command first (runs it in background)");
                } else {
                    self.state.push_system(format!("background: {cmd}"));
                    self.send_cmd(RpcCommand::Bash {
                        command: cmd,
                        exclude_from_context: None,
                    });
                }
                true
            }
            // Ctrl+O: expand/collapse the latest tool card.
            (KeyCode::Char('o'), true, _) => {
                self.state.toggle_last_tool();
                true
            }
            // Ctrl+G: open the input in $EDITOR (RECON §12.4
            // open_external_editor).
            (KeyCode::Char('g'), true, _) => {
                self.open_external_editor();
                true
            }
            // Ctrl+V: paste clipboard — image → attachment, else text
            // (RECON §12.3 "ctrl+v to paste image in clipboard").
            (KeyCode::Char('v'), true, _) => {
                self.paste_clipboard();
                true
            }
            // Ctrl+P: cycle model (pi keybinding: cycle model forward).
            (KeyCode::Char('p'), true, _) => {
                self.send_report(RpcCommand::CycleModel);
                true
            }
            // Ctrl+D: quit when the input is empty (pi: exit on empty),
            // otherwise delete-char (Emacs).
            (KeyCode::Char('d'), true, _) => {
                if self.state.input.text.is_empty() {
                    self.state.quit = true;
                } else {
                    self.state.input.delete();
                }
                true
            }
            // Ctrl+L: clear the message list; Ctrl+Shift+L: full redraw.
            (KeyCode::Char('l'), true, true) => {
                self.renderer.needs_full_redraw = true;
                true
            }
            (KeyCode::Char('l'), true, false) => {
                self.state.clear_messages();
                self.renderer.needs_full_redraw = true;
                true
            }
            // Esc twice to interrupt (Devin). First Esc while streaming
            // only arms the window; non-streaming Esc clears the input.
            (KeyCode::Esc, _, _) => {
                if self.state.streaming {
                    let armed = self
                        .last_esc
                        .is_some_and(|t| t.elapsed() < ESC_INTERRUPT_WINDOW);
                    if armed {
                        self.last_esc = None;
                        self.state.aborting = true;
                        self.send_cmd(RpcCommand::Abort);
                    } else {
                        self.last_esc = Some(Instant::now());
                        self.state.push_system("esc again to interrupt");
                    }
                } else if !self.state.input.text.is_empty() {
                    self.state.input.text.clear();
                    self.state.input.cursor = 0;
                }
                true
            }
            (KeyCode::Enter, false, _) => {
                self.submit_input();
                true
            }
            (KeyCode::Char('j'), true, _) | (KeyCode::Enter, true, _) => {
                self.state.input.insert_char('\n');
                true
            }
            // Emacs editing ops (editor context).
            (KeyCode::Char('a'), true, _) => {
                self.state.input.move_home();
                true
            }
            (KeyCode::Char('e'), true, _) => {
                self.state.input.move_end();
                true
            }
            (KeyCode::Char('f'), true, _) => {
                self.state.input.move_right();
                true
            }
            (KeyCode::Char('h'), true, _) => {
                self.state.input.backspace();
                true
            }
            (KeyCode::Char('k'), true, _) => {
                self.state.input.kill_line();
                true
            }
            (KeyCode::Char('u'), true, _) => {
                self.state.input.backward_kill_line();
                true
            }
            (KeyCode::Char('w'), true, _) => {
                self.state.input.unix_word_rubout();
                true
            }
            (KeyCode::Char('y'), true, _) => {
                self.state.input.yank();
                true
            }
            (KeyCode::Char('t'), true, _) => {
                self.state.input.transpose_chars();
                true
            }
            // Ctrl+R: reverse history search (previous entry containing
            // the in-progress text).
            (KeyCode::Char('r'), true, _) => {
                self.state.input.history_search();
                true
            }
            // Ctrl+S: scrollback search (Ctrl+F is Emacs move-right).
            (KeyCode::Char('s'), true, _) => {
                self.state.search = Some(crate::state::SearchState::default());
                self.state.dom_dirty = true;
                true
            }
            // F3: thinking-trace overlay (Devin `alt_screen`).
            (KeyCode::F(3), _, _) => {
                self.state.trace_open = true;
                self.state.trace_scroll = u32::MAX; // clamped to bottom
                self.state.dom_dirty = true;
                true
            }
            (KeyCode::Backspace, true, _) => {
                self.state.input.backward_kill_word();
                true
            }
            (KeyCode::Backspace, _, _) => {
                self.state.input.backspace();
                true
            }
            (KeyCode::Delete, _, _) => {
                self.state.input.delete();
                true
            }
            (KeyCode::Left, true, _) => {
                self.state.input.move_word_left();
                true
            }
            (KeyCode::Left, _, _) => {
                self.state.input.move_left();
                true
            }
            (KeyCode::Right, true, _) => {
                self.state.input.move_word_right();
                true
            }
            (KeyCode::Right, false, _)
                if self.state.input.cursor == self.state.input.text.len()
                    && self.state.input.ghost.is_some() =>
            {
                self.state.input.accept_ghost();
                true
            }
            (KeyCode::Right, _, _) => {
                self.state.input.move_right();
                true
            }
            (KeyCode::Home, _, _) => {
                self.state.input.move_home();
                true
            }
            (KeyCode::End, _, _) if self.state.input.ghost.is_some() => {
                self.state.input.accept_ghost();
                true
            }
            (KeyCode::End, _, _) => {
                self.state.input.move_end();
                true
            }
            // Up/Down: move between input lines; on the first/last line
            // fall back to prompt history.
            (KeyCode::Up, _, _) => {
                if !self.state.input.prev_line() {
                    self.state.input.history_up();
                }
                true
            }
            (KeyCode::Down, _, _) => {
                if !self.state.input.next_line() {
                    self.state.input.history_down();
                }
                true
            }
            (KeyCode::PageUp, _, _) => {
                let page = self.messages_view_h.max(1) as i32;
                self.scroll_messages(-page);
                true
            }
            (KeyCode::PageDown, _, _) => {
                let page = self.messages_view_h.max(1) as i32;
                self.scroll_messages(page);
                true
            }
            (KeyCode::Char(c), false, _) => {
                self.state.input.insert_char(c);
                true
            }
            _ => false,
        }
    }

    /// Key handling while an extension-UI dialog is active.
    fn handle_dialog_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let code = key.code;
        // Alt+Left/Right defers to the prev/next queued question (set
        // inside the dialog borrow, applied after it).
        let mut defer: i64 = 0;
        match &mut self.state.dialog {
            Some(DialogState::Select { id, sel }) => match (code, ctrl) {
                (KeyCode::Right, _) if alt => defer = 1,
                (KeyCode::Left, _) if alt => defer = -1,
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state
                        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        });
                }
                (KeyCode::Up, _) => sel.move_up(),
                (KeyCode::Down, _) => sel.move_down(),
                (KeyCode::PageUp, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_up();
                    }
                }
                (KeyCode::PageDown, _) => {
                    for _ in 0..select::MAX_VISIBLE {
                        sel.move_down();
                    }
                }
                (KeyCode::Enter, _) => {
                    if let Some(value) = sel.selected_label() {
                        let id = id.clone();
                        self.state
                            .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value { id, value });
                    }
                }
                (KeyCode::Backspace, _) => sel.pop_filter(),
                (KeyCode::Char(c), false) => sel.push_filter(c),
                _ => {}
            },
            Some(DialogState::Confirm { id, .. }) => {
                let id = id.clone();
                match (code, alt) {
                    (KeyCode::Right, true) => defer = 1,
                    (KeyCode::Left, true) => defer = -1,
                    (KeyCode::Char('y'), _) | (KeyCode::Char('Y'), _) | (KeyCode::Enter, _) => {
                        self.state
                            .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Confirmed {
                                id,
                                confirmed: true,
                            });
                    }
                    (KeyCode::Char('n'), _) | (KeyCode::Char('N'), _) => {
                        self.state
                            .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Confirmed {
                                id,
                                confirmed: false,
                            });
                    }
                    (KeyCode::Esc, _) => self.state.cancel_dialog(),
                    _ => {}
                }
            }
            Some(DialogState::Input { id, input, .. }) => match (code, ctrl) {
                (KeyCode::Right, _) if alt => defer = 1,
                (KeyCode::Left, _) if alt => defer = -1,
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state
                        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        });
                }
                (KeyCode::Enter, _) => {
                    let value = input.take_submitted();
                    let id = id.clone();
                    self.state
                        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value { id, value });
                }
                _ => edit_keys(input, key),
            },
            Some(DialogState::Editor { id, input, .. }) => match (code, ctrl) {
                (KeyCode::Right, _) if alt => defer = 1,
                (KeyCode::Left, _) if alt => defer = -1,
                (KeyCode::Esc, _) => {
                    let id = id.clone();
                    self.state
                        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Cancelled {
                            id,
                            cancelled: true,
                        });
                }
                // Ctrl+Enter / Ctrl+S submit; Enter inserts a newline.
                (KeyCode::Enter, true) | (KeyCode::Char('s'), true) => {
                    let value = input.take_submitted();
                    let id = id.clone();
                    self.state
                        .resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value { id, value });
                }
                (KeyCode::Enter, false) => input.insert_char('\n'),
                _ => edit_keys(input, key),
            },
            Some(DialogState::Plugin {
                id, spec, driver, ..
            }) => {
                match driver {
                    // Plugin-driven: every key is forwarded as an
                    // `extension_ui_event`; Esc dismisses locally only when
                    // the spec allows it.
                    pi_rpc::OverlayDriver::Plugin => {
                        let id = id.clone();
                        if code == KeyCode::Esc && spec.dismissable.unwrap_or(true) {
                            self.send_ui_event(&id, pi_rpc::UiEvent::Dismissed);
                            self.state.cancel_dialog();
                        } else {
                            self.send_ui_event(
                                &id,
                                pi_rpc::UiEvent::Key {
                                    key: key_id(key),
                                    mods: key_mods(key),
                                },
                            );
                        }
                    }
                    // Client-driven fields land in P3; for now Esc cancels.
                    pi_rpc::OverlayDriver::Client => {
                        if code == KeyCode::Esc {
                            self.state.cancel_dialog();
                        }
                    }
                }
            }
            Some(DialogState::Local { sel, action }) => {
                // /theme picker: cursor moves preview live; Esc restores
                // `theme_restore`, Enter commits via dispatch_local_select.
                let theme_picker = *action == LocalAction::SetTheme;
                let mut preview = false;
                let mut restore = None;
                match (code, ctrl) {
                    (KeyCode::Esc, _) => {
                        if sel.detail.is_some() {
                            // Detail page: Esc backs out to the list.
                            sel.detail = None;
                        } else {
                            if theme_picker {
                                restore = self.state.theme_restore.take();
                            }
                            self.state.cancel_dialog();
                        }
                    }
                    // Tab: model picker metadata detail page (Devin
                    // `next_metadata`) — only for the /model picker.
                    (KeyCode::Tab, _) => {
                        if *action == LocalAction::SetModel {
                            if sel.detail.is_some() {
                                sel.detail = None;
                            } else if let Some(i) = sel.selected() {
                                if let Some(m) = self.state.models.get(i) {
                                    sel.detail = Some(select::model_detail(m));
                                }
                            }
                        }
                    }
                    (KeyCode::Up, _) => {
                        sel.move_up();
                        preview = theme_picker;
                    }
                    (KeyCode::Down, _) => {
                        sel.move_down();
                        preview = theme_picker;
                    }
                    (KeyCode::PageUp, _) => {
                        for _ in 0..select::MAX_VISIBLE {
                            sel.move_up();
                        }
                        preview = theme_picker;
                    }
                    (KeyCode::PageDown, _) => {
                        for _ in 0..select::MAX_VISIBLE {
                            sel.move_down();
                        }
                        preview = theme_picker;
                    }
                    (KeyCode::Enter, _) => {
                        let action = *action;
                        if let Some(i) = sel.selected() {
                            self.state.dialog = None;
                            self.dispatch_local_select(action, i);
                        }
                    }
                    (KeyCode::Backspace, _) => {
                        sel.pop_filter();
                        preview = theme_picker;
                    }
                    (KeyCode::Char(c), false) => {
                        sel.push_filter(c);
                        preview = theme_picker;
                    }
                    _ => {}
                }
                if let Some(kind) = restore {
                    self.apply_theme(kind);
                }
                if preview {
                    self.preview_theme_selection();
                }
            }
            None => return false,
        }
        if defer != 0 {
            self.state.defer_question(defer);
        }
        self.state.dom_dirty = true;
        true
    }

    /// Key handling while the subagent tray is open (RECON §12.2 tray
    /// keymap: view/kill/foreground/close + tab navigation).
    fn handle_tray_key(&mut self, key: KeyEvent) -> bool {
        if key.kind == KeyEventKind::Release {
            return false;
        }
        match key.code {
            KeyCode::Esc | KeyCode::F(2) | KeyCode::Char('q') => {
                self.state.tray.open = false;
            }
            KeyCode::Tab | KeyCode::Right => {
                let t = self.state.tray.tab.next();
                self.state.tray.set_tab(t);
            }
            KeyCode::BackTab | KeyCode::Left => {
                let t = self.state.tray.tab.prev();
                self.state.tray.set_tab(t);
            }
            KeyCode::Up => self.state.tray.move_up(),
            KeyCode::Down => {
                let rows = self.state.tray.rows(self.state.todos.len());
                self.state.tray.move_down(rows);
            }
            // view: expand the entry's tool card and scroll to it.
            KeyCode::Enter => {
                if let Some(ei) = self.state.tray.selected() {
                    let msg_idx = self.state.tray.entries[ei].msg_idx;
                    if let Some(m) = self.state.messages.get_mut(msg_idx) {
                        if m.tool_output.is_some() {
                            m.expanded = true;
                            m.dirty = true;
                        }
                    }
                    self.state.tray.open = false;
                    self.scroll_to_message(msg_idx);
                }
            }
            // kill: shells get `abort_bash`; teammate rows carry a
            // `steer_target` and get the per-agent `/teammate-abort`;
            // other subagents share the run, so abort is session-scoped.
            KeyCode::Char('x') | KeyCode::Char('k') => {
                if let Some(ei) = self.state.tray.selected() {
                    let (kind, target) = {
                        let e = &mut self.state.tray.entries[ei];
                        if e.status == crate::state::TrayStatus::Running {
                            e.status = crate::state::TrayStatus::Cancelled;
                            (Some(e.kind), e.steer_target.clone())
                        } else {
                            (None, None)
                        }
                    };
                    if let Some(kind) = kind {
                        if let Some((cmd, note)) =
                            tray_cancel_command(kind, target, self.state.streaming)
                        {
                            self.send_cmd(cmd);
                            if !note.is_empty() {
                                self.state.push_system(note);
                            }
                        }
                    }
                }
            }
            // foreground/background: Devin subagent/mode — toggle
            // whether the entry's nested tool cards stream into the
            // main scrollback.
            KeyCode::Char('f') => {
                if let Some(fg) = self.state.toggle_tray_foreground() {
                    self.state.push_system(if fg {
                        "subagent moved to foreground"
                    } else {
                        "subagent moved to background"
                    });
                }
            }
            // steer: prefill `/teammate-send <correlationId> ` so the
            // user can type a message for that agent (cockpit overlay
            // steer parity — the command routes it as a follow-up).
            KeyCode::Char('s') => {
                if let Some(ei) = self.state.tray.selected() {
                    if let Some(target) = self.state.tray.entries[ei].steer_target.clone() {
                        let text = format!("/teammate-send {target} ");
                        self.state.input.cursor = text.len();
                        self.state.input.text = text;
                        self.state.tray.open = false;
                    }
                }
            }
            // view: teammate rows query live output via `/teammate-watch`
            // (their msg_idx is the shared dispatch card — or dangling for
            // hydrated history rows); other rows jump to their card.
            KeyCode::Char('v') => {
                if let Some(ei) = self.state.tray.selected() {
                    let (msg_idx, target) = {
                        let e = &self.state.tray.entries[ei];
                        (e.msg_idx, e.steer_target.clone())
                    };
                    self.state.tray.open = false;
                    if let Some(target) = target {
                        self.send_cmd(RpcCommand::Prompt {
                            message: format!("/teammate-watch {target}"),
                            images: None,
                            streaming_behavior: None,
                        });
                        self.state.push_system(format!("watch → {target}"));
                    } else {
                        self.scroll_to_message(msg_idx);
                    }
                } else {
                    self.state.tray.open = false;
                }
            }
            _ => {}
        }
        self.state.dom_dirty = true;
        true
    }

    /// Key handling while scrollback search is open: typing edits the
    /// query (matches recompute live), Enter/BackTab step through hits,
    /// Esc closes and clears all marks.
    fn handle_search_key(&mut self, key: KeyEvent) -> bool {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        match (key.code, ctrl) {
            (KeyCode::Esc, _) => {
                for m in &mut self.state.messages {
                    m.search_mark = crate::state::SearchMark::None;
                }
                self.state.search = None;
            }
            (KeyCode::Enter, false) => {
                if let Some(idx) = self
                    .state
                    .search
                    .as_mut()
                    .and_then(|s| s.step(&mut self.state.messages, 1))
                {
                    self.scroll_to_message(idx);
                }
            }
            (KeyCode::BackTab, _) | (KeyCode::Enter, true) => {
                if let Some(idx) = self
                    .state
                    .search
                    .as_mut()
                    .and_then(|s| s.step(&mut self.state.messages, -1))
                {
                    self.scroll_to_message(idx);
                }
            }
            (KeyCode::Backspace, _) => {
                if let Some(s) = &mut self.state.search {
                    s.query.pop();
                    let idx = s.refresh(&mut self.state.messages);
                    if let Some(i) = idx {
                        self.scroll_to_message(i);
                    }
                }
            }
            (KeyCode::Char(c), false) => {
                if let Some(s) = &mut self.state.search {
                    s.query.push(c);
                    let idx = s.refresh(&mut self.state.messages);
                    if let Some(i) = idx {
                        self.scroll_to_message(i);
                    }
                }
            }
            _ => {}
        }
        self.state.dom_dirty = true;
        true
    }

    /// Key handling while the thinking-trace overlay is open:
    /// scroll only; Esc/Alt+T close back to the conversation.
    fn handle_trace_key(&mut self, key: KeyEvent) -> bool {
        match key.code {
            KeyCode::Esc | KeyCode::F(3) => {
                self.state.trace_open = false;
            }
            KeyCode::Up => {
                self.state.trace_scroll = self.state.trace_scroll.saturating_sub(1);
            }
            KeyCode::Down => {
                self.state.trace_scroll = self.state.trace_scroll.saturating_add(1);
            }
            KeyCode::PageUp => {
                let page = self.messages_view_h.max(1);
                self.state.trace_scroll = self.state.trace_scroll.saturating_sub(page);
            }
            KeyCode::PageDown => {
                let page = self.messages_view_h.max(1);
                self.state.trace_scroll = self.state.trace_scroll.saturating_add(page);
            }
            _ => {}
        }
        self.state.dom_dirty = true;
        true
    }

    /// Scroll the message list so `msg_idx`'s bubble is at the top.
    /// `state.scroll` is a bottom-anchored offset (0 = tail), so the
    /// target is `content_height - (bubble height + heights below)`.
    fn scroll_to_message(&mut self, msg_idx: usize) {
        self.state.follow_tail = false;
        let Some(target) = self.state.messages.get(msg_idx).and_then(|m| m.node_id) else {
            return;
        };
        let content_h = self
            .doc
            .get_node(self.handles.messages)
            .map(|n| n.scrollable_overflow().height())
            .unwrap_or(0.0);
        let target_h = self
            .doc
            .get_node(target)
            .map(|n| n.final_layout().size.height as f64 + 1.0)
            .unwrap_or(0.0);
        let mut below = 0.0;
        for m in self.state.messages.iter().skip(msg_idx + 1) {
            if let Some(id) = m.node_id {
                if let Some(n) = self.doc.get_node(id) {
                    below += n.final_layout().size.height as f64 + 1.0;
                }
            }
        }
        self.state.scroll = (content_h - below - target_h).max(0.0) as u32;
    }

    /// The `#input-hint` line for this frame.
    fn input_hint(state: &AppState) -> String {
        // Trace overlay replaces the hint while open.
        if state.trace_open {
            return "thinking trace — ↑↓/pgup/pgdn scroll · esc/f3 close".to_string();
        }
        // Scrollback search bar replaces the hint while open.
        if let Some(s) = &state.search {
            return match s.matches.len() {
                0 if s.query.is_empty() => "search: (type to filter · esc close)".to_string(),
                0 => format!("search: {} — no matches (esc close)", s.query),
                n => format!(
                    "search: {} — {}/{} (enter next · shift+enter prev · esc close)",
                    s.query,
                    s.cursor + 1,
                    n
                ),
            };
        }
        let tip = if state.show_tips() {
            input_box::TIPS[state.tip_idx]
        } else {
            ""
        };
        let hint = input_box::hint_for(&state.input, &state.attachments, state.attachment_sel, tip);
        if state
            .settings
            .get("show_cwd_in_input_border")
            .copied()
            .unwrap_or(true)
        {
            if let Ok(cwd) = std::env::current_dir() {
                if hint.is_empty() {
                    return cwd.display().to_string();
                }
                return format!("{} · {hint}", cwd.display());
            }
        }
        hint
    }

    /// Scroll the message list by `delta` cells (negative = up).
    fn scroll_messages(&mut self, delta: i32) {
        if delta < 0 {
            self.state.follow_tail = false;
            self.state.scroll = self.state.scroll.saturating_sub((-delta) as u32);
        } else {
            self.state.scroll = self.state.scroll.saturating_add(delta as u32);
            // Re-enable follow when we hit the bottom (clamped in
            // apply_scroll; approximate here).
            let max = self.max_scroll();
            if self.state.scroll >= max {
                self.state.follow_tail = true;
            }
        }
    }

    fn max_scroll(&self) -> u32 {
        let Some(node) = self.doc.get_node(self.handles.messages) else {
            return 0;
        };
        let content = node.scrollable_overflow().height();
        let view = node.final_layout().size.height as f64;
        (content - view).max(0.0) as u32
    }

    /// Submit the current input: slash commands are handled locally,
    /// everything else goes to pi as a `prompt`.
    ///
    /// While streaming, the first Enter on text queues it as a
    /// follow-up (default), a second Enter on empty input steers every
    /// queued message, and a third interrupts the run (Devin ladder).
    fn submit_input(&mut self) {
        let text = self.state.input.take_submitted();
        if text.trim().is_empty() {
            if self.state.streaming {
                if self.state.queued.is_empty() {
                    self.send_cmd(RpcCommand::Abort);
                } else {
                    let queued = std::mem::take(&mut self.state.queued);
                    self.send_cmd(RpcCommand::ClearQueue);
                    for q in queued {
                        self.send_cmd(RpcCommand::Steer {
                            message: q.text,
                            images: None,
                        });
                    }
                    self.state.dom_dirty = true;
                }
            }
            return;
        }
        match commands::parse(&text) {
            Command::Prompt(p) => {
                // Attached images (Ctrl+V) ride along with the prompt.
                let images = if self.state.attachments.is_empty() {
                    None
                } else {
                    Some(
                        self.state
                            .attachments
                            .drain(..)
                            .map(|a| pi_rpc::MessageContent::Image {
                                data: a.data,
                                mime_type: a.mime,
                            })
                            .collect(),
                    )
                };
                self.state.attachment_sel = None;
                if self.state.streaming {
                    let mode = self
                        .state
                        .steering_mode
                        .unwrap_or(StreamingBehavior::FollowUp);
                    let slash_name = p
                        .strip_prefix('/')
                        .and_then(|b| b.split(char::is_whitespace).next())
                        .unwrap_or("");
                    let is_ext = self.state.is_extension_command(slash_name);
                    let cmd = if is_ext {
                        // Extension commands can't queue — `prompt`
                        // executes them immediately, before pi's
                        // streaming check.
                        RpcCommand::Prompt {
                            message: p.clone(),
                            images,
                            streaming_behavior: None,
                        }
                    } else if p.starts_with('/') {
                        // Skill/template/unknown slash input: `prompt`
                        // expands it server-side, `streamingBehavior`
                        // keeps the queue/steer semantics for
                        // non-command text.
                        RpcCommand::Prompt {
                            message: p.clone(),
                            images,
                            streaming_behavior: Some(mode),
                        }
                    } else {
                        streaming_input_command(self.state.steering_mode, p.clone(), images)
                    };
                    // A queued follow-up stays out of the transcript
                    // until its message_start — the queue list is its
                    // echo. Steer messages deliver now, so echo now.
                    // Extension commands produce no user message on pi's
                    // side — echoing them would litter the stream.
                    if !is_ext && mode == StreamingBehavior::Steer {
                        self.state.push_user(p);
                        self.state.follow_tail = true;
                    }
                    self.send_cmd(cmd);
                } else {
                    // Local echo (deduped against message_start).
                    // Extension commands never produce a user message —
                    // pi swallows them server-side — so skip the echo.
                    let is_ext = p
                        .strip_prefix('/')
                        .and_then(|b| b.split(char::is_whitespace).next())
                        .map(|name| self.state.is_extension_command(name))
                        .unwrap_or(false);
                    if !is_ext {
                        self.state.push_user(p.clone());
                        self.state.follow_tail = true;
                    }
                    self.send_cmd(RpcCommand::Prompt {
                        message: p,
                        images,
                        streaming_behavior: None,
                    });
                }
            }
            Command::Local(cmd) => self.dispatch_local(cmd),
        }
    }

    /// Swap the active theme at runtime: remove the old UA sheet before
    /// adding the new one (blitz-dom appends — re-adding only would
    /// accumulate a full stylesheet per switch), then force a full
    /// re-style + repaint on the next frame.
    fn apply_theme(&mut self, kind: ThemeKind) {
        if kind == self.theme_kind {
            return;
        }
        self.doc.remove_user_agent_stylesheet(&self.theme_css);
        self.theme_css = theme::stylesheet(kind);
        self.doc.add_user_agent_stylesheet(&self.theme_css);
        self.theme = Theme::new(kind);
        self.theme_kind = kind;
        // (0,0) forces the next set_viewport → Device rebuild with the
        // new color_scheme; the redraw/rebuild flags repaint all cells.
        self.last_viewport = (0, 0);
        // Signature caches gate component syncs — reset them so every
        // component re-pushes its theme-colored inline styles (e.g. the
        // spinner's per-frame fusion gradient) on the next frame.
        self.spinner_sig = u64::MAX;
        self.input_sig = u64::MAX;
        self.status_sig = u64::MAX;
        self.dialog_sig = u64::MAX;
        self.completion_sig = u64::MAX;
        self.renderer.needs_full_redraw = true;
        self.state.needs_rebuild = true;
        self.state.dom_dirty = true;
    }

    /// `/theme` picker preview: apply the highlighted row's theme
    /// (index 0 = `auto` → re-detect). Committed/reverted by the
    /// dialog's Enter/Esc arms via `state.theme_restore`.
    fn preview_theme_selection(&mut self) {
        if let Some(DialogState::Local { sel, .. }) = &self.state.dialog {
            if let Some(kind) = sel.selected().and_then(select::theme_picker_kind) {
                self.apply_theme(kind);
            }
        }
    }

    /// Execute a locally-handled slash command.
    fn dispatch_local(&mut self, cmd: LocalCmd) {
        match cmd {
            LocalCmd::Model(None) => self.send_report(RpcCommand::GetAvailableModels),
            LocalCmd::Model(Some(spec)) => self.set_model_from_spec(&spec),
            LocalCmd::Thinking(None) => self.send_report(RpcCommand::GetAvailableThinkingLevels),
            LocalCmd::Thinking(Some(level)) => match parse_thinking_level(&level) {
                Some(level) => self.send_report(RpcCommand::SetThinkingLevel { level }),
                None => self.state.push_system(format!(
                    "unknown thinking level '{level}' (off|minimal|low|medium|high|xhigh|max)"
                )),
            },
            LocalCmd::NewSession => self.send_report(RpcCommand::NewSession {
                parent_session: None,
            }),
            // RPC exposes entries in the current session, not a list of
            // session files, so /resume honestly acts as a fork-point picker.
            LocalCmd::Resume => self.send_report(RpcCommand::GetEntries { since: None }),
            LocalCmd::Tree => self.send_report(RpcCommand::GetTree),
            LocalCmd::Fork => self.send_report(RpcCommand::GetForkMessages),
            LocalCmd::Clone => self.send_report(RpcCommand::Clone),
            LocalCmd::Import(session_path) => {
                self.send_report(RpcCommand::SwitchSession { session_path })
            }
            LocalCmd::Unsupported(name) => self
                .state
                .push_system(format!("/{name}: not supported over RPC")),
            LocalCmd::Compact(instructions) => self.send_report(RpcCommand::Compact {
                custom_instructions: instructions,
            }),
            LocalCmd::Session => self.send_report(RpcCommand::GetSessionStats),
            LocalCmd::Export(path) => {
                self.send_report(RpcCommand::ExportHtml { output_path: path })
            }
            LocalCmd::Name(name) => self.send_report(RpcCommand::SetSessionName { name }),
            LocalCmd::Copy => self.send_report(RpcCommand::GetLastAssistantText),
            LocalCmd::Clear => self.state.clear_messages(),
            LocalCmd::Settings => self.state.open_local_select(LocalAction::ToggleSetting),
            LocalCmd::Theme(None) => self.state.open_theme_select(self.theme_kind),
            LocalCmd::Theme(Some(name)) => {
                if name == "auto" {
                    self.state.theme_override = None;
                    self.state.settings.insert("theme_auto_detect".into(), true);
                    self.apply_theme(theme::detect());
                    self.state
                        .push_system(format!("theme → auto ({})", self.theme_kind.name()));
                } else {
                    match ThemeKind::from_name(&name) {
                        Some(kind) => {
                            self.state.theme_override = Some(kind);
                            self.state
                                .settings
                                .insert("theme_auto_detect".into(), false);
                            self.apply_theme(kind);
                            self.state.push_system(format!("theme → {}", kind.name()));
                        }
                        None => {
                            let names: Vec<&str> =
                                ThemeKind::ALL.iter().map(|k| k.name()).collect();
                            self.state.push_system(format!(
                                "unknown theme '{name}' ({}|auto)",
                                names.join("|")
                            ));
                        }
                    }
                }
            }
            // /unqueue: recall the last queued message into the input.
            // pi only exposes `clear_queue`, so we clear then re-queue
            // the remaining messages in their own mode.
            LocalCmd::Unqueue => {
                if let Some(last) = self.state.queued.pop() {
                    let rest = std::mem::take(&mut self.state.queued);
                    self.send_cmd(RpcCommand::ClearQueue);
                    for q in rest {
                        // Re-queue each remaining message in its own mode.
                        self.send_cmd(if q.steering {
                            RpcCommand::Steer {
                                message: q.text,
                                images: None,
                            }
                        } else {
                            RpcCommand::FollowUp {
                                message: q.text,
                                images: None,
                            }
                        });
                    }
                    self.state.input.text = last.text;
                    self.state.input.cursor = self.state.input.text.len();
                    self.state.dom_dirty = true;
                } else {
                    self.state.push_system("queue is empty");
                }
            }
            LocalCmd::Help => {
                for (name, desc) in commands::BUILTIN_HELP {
                    self.state.push_system(format!("{name} — {desc}"));
                }
                // pi-side commands (extension/prompt/skill) appended async.
                self.send_report(RpcCommand::GetCommands);
            }
            LocalCmd::Quit => self.state.quit = true,
        }
    }

    /// `/model <spec>` — `provider/id` splits directly; a bare id is
    /// resolved against the cached `get_available_models` list.
    fn set_model_from_spec(&mut self, spec: &str) {
        if let Some((provider, id)) = spec.split_once('/') {
            self.send_report(RpcCommand::SetModel {
                provider: provider.to_string(),
                model_id: id.to_string(),
            });
            return;
        }
        match self.state.models.iter().find(|m| m.id == spec) {
            Some(m) => {
                let (provider, id) = (m.provider.clone(), m.id.clone());
                self.send_report(RpcCommand::SetModel {
                    provider,
                    model_id: id,
                });
            }
            None => {
                if self.state.models.is_empty() {
                    // No cache — fetch the list, then let the user pick.
                    self.state.push_system(format!(
                        "model list not loaded; use /model to pick (or /model provider/{spec})"
                    ));
                    self.send_report(RpcCommand::GetAvailableModels);
                } else {
                    self.state
                        .push_system(format!("unknown model '{spec}' — use /model to pick"));
                }
            }
        }
    }

    /// A `DialogState::Local` selection was confirmed: dispatch the
    /// command for the picked index.
    fn dispatch_local_select(&mut self, action: LocalAction, index: usize) {
        match action {
            LocalAction::SetModel => {
                if let Some(m) = self.state.models.get(index) {
                    let (provider, id) = (m.provider.clone(), m.id.clone());
                    self.send_report(RpcCommand::SetModel {
                        provider,
                        model_id: id,
                    });
                }
            }
            LocalAction::SetThinking => {
                if let Some(level) = self.state.thinking_levels.get(index).copied() {
                    self.send_report(RpcCommand::SetThinkingLevel { level });
                }
            }
            LocalAction::ToggleSetting => {
                // Toggle in place and keep the picker open: flip the
                // value, then re-open on the same row (the Enter arm
                // already closed the dialog). Preserve the active
                // filter so repeated toggles don't lose the search.
                let keep_filter = match &self.state.dialog {
                    Some(DialogState::Local { sel, .. }) => sel.filter.clone(),
                    _ => String::new(),
                };
                if let Some(key) = crate::state::SETTINGS_KEYS.get(index).copied() {
                    let on = !self.state.settings.get(key).copied().unwrap_or(true);
                    self.state.settings.insert(key.to_string(), on);
                    match key {
                        "mouse_capture" => {
                            let mut out = io::stdout().lock();
                            let result = if on {
                                execute!(out, EnableMouseCapture)
                            } else {
                                execute!(out, DisableMouseCapture)
                            };
                            drop(out);
                            if let Err(e) = result {
                                self.state
                                    .push_system(format!("mouse capture toggle failed: {e}"));
                            }
                        }
                        "symbol_mode" => {
                            self.state.glyphs = if on {
                                crate::components::glyphs::GlyphMode::Unicode
                            } else {
                                crate::components::glyphs::GlyphMode::Ascii
                            };
                            self.state.needs_rebuild = true;
                        }
                        "theme_auto_detect" => {
                            if on {
                                self.state.theme_override = None;
                                self.apply_theme(theme::detect());
                            } else {
                                self.state.theme_override = Some(self.theme_kind);
                            }
                        }
                        "include_gitignored_in_mentions" => {
                            self.state.file_index = None;
                        }
                        "subagents_enabled" => {
                            if !on {
                                self.state.tray.open = false;
                                // Collection happens in the shared event reducer;
                                // discard existing cached entries while disabled.
                                self.state.tray.entries.clear();
                                self.state.tray.cursor = 0;
                            }
                        }
                        "startup_tips_remaining" => {
                            // Boolean proxy: off permanently dismisses the
                            // startup banner; on restores it only before the
                            // first user message in this run.
                            self.state.banner_visible =
                                on && !self.state.messages.iter().any(|m| m.kind == MsgKind::User);
                            self.state.needs_rebuild = true;
                        }
                        "show_tips" | "show_cwd_in_input_border" => {}
                        _ => {}
                    }
                    self.state.open_local_select(LocalAction::ToggleSetting);
                    if let Some(DialogState::Local { sel, .. }) = &mut self.state.dialog {
                        sel.filter = keep_filter;
                        // `index` is an options index; the cursor is a
                        // filtered index — map back through filtered().
                        sel.cursor = sel
                            .filtered()
                            .iter()
                            .position(|&oi| oi == index)
                            .unwrap_or(0);
                    }
                }
            }
            LocalAction::ResumeEntry | LocalAction::TreeEntry | LocalAction::ForkEntry => {
                if let Some((entry_id, _)) = self.state.session_points.get(index) {
                    self.send_report(RpcCommand::Fork {
                        entry_id: entry_id.clone(),
                    });
                }
            }
            LocalAction::SetTheme => {
                self.state.theme_restore = None;
                match select::theme_picker_kind(index) {
                    Some(kind) if index == 0 => {
                        // `auto` row: follow detection, unpin the override.
                        self.state.theme_override = None;
                        self.state.settings.insert("theme_auto_detect".into(), true);
                        self.apply_theme(kind);
                        self.state
                            .push_system(format!("theme → auto ({})", kind.name()));
                    }
                    Some(kind) => {
                        self.state.theme_override = Some(kind);
                        self.state
                            .settings
                            .insert("theme_auto_detect".into(), false);
                        self.apply_theme(kind);
                        self.state.push_system(format!("theme → {}", kind.name()));
                    }
                    None => {}
                }
            }
        }
        self.state.dom_dirty = true;
    }

    /// Send an RPC command and route the full response back through the
    /// event loop (`cmd_rx` → `handle_cmd_response`).
    fn send_report(&self, cmd: RpcCommand) {
        let rpc = Arc::clone(&self.rpc);
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            match rpc.send(&cmd).await {
                Ok(resp) => {
                    let _ = tx.send(resp);
                }
                Err(e) => {
                    let _ = tx.send(RpcResponse::failure(
                        None,
                        cmd.command_type(),
                        format!("send error: {e}"),
                    ));
                }
            }
        });
    }

    /// Background `get_entries` fetch for the todo strip. The response
    /// is re-tagged `todo_entries` so `handle_cmd_response` hydrates
    /// `state.todos` instead of routing it into the `/resume` picker
    /// (which shares the same wire command).
    fn fetch_todos(&mut self) {
        let rpc = Arc::clone(&self.rpc);
        let tx = self.cmd_tx.clone();
        tokio::spawn(async move {
            if let Ok(mut resp) = rpc.send(&RpcCommand::GetEntries { since: None }).await {
                resp.command = "todo_entries".into();
                let _ = tx.send(resp);
            }
        });
    }

    /// Reduce a slash-command response: state reducer + side effects.
    fn handle_cmd_response(&mut self, resp: RpcResponse) -> bool {
        // Background todo fetches never reach apply_response.
        if resp.command == "todo_entries" {
            return self.state.hydrate_todos(&resp);
        }
        match self.state.apply_response(&resp) {
            ResponseEffect::RefreshState => {
                // Fire-and-forget: the get_state response comes back on
                // cmd_rx and lands in the `get_state` arm below.
                self.send_report(RpcCommand::GetState);
                true
            }
            ResponseEffect::CopyToClipboard(text) => {
                match copy_to_clipboard(&text) {
                    Ok(()) => self.state.push_system("copied to clipboard"),
                    Err(e) => self.state.push_system(format!("clipboard failed: {e}")),
                }
                true
            }
            ResponseEffect::None => {
                // `get_state` responses land here — refresh the status line.
                if resp.command == "get_state" {
                    if let Some(s) = resp.session_state() {
                        if let Some(m) = s.model {
                            self.state.status.model = m.id;
                            self.state.status.context_window = m.context_window as u64;
                        }
                        self.state.status.thinking =
                            format!("{:?}", s.thinking_level).to_lowercase();
                        // `s.steering_mode` is the server's queue drain policy
                        // (all/one-at-a-time), not this TUI's steer/follow-up
                        // submission choice; keep the local status label.
                        self.state.streaming = s.is_streaming;
                        return true;
                    }
                }
                if resp.command == "get_commands" {
                    // The user may have typed `/` before the asynchronous
                    // startup fetch completed. Refresh the visible popup as
                    // soon as extension/skill commands arrive.
                    self.refresh_completion();
                    return true;
                }
                self.state.dom_dirty
            }
        }
    }

    /// Fire-and-forget an RPC command; failures surface as system lines.
    pub fn send_cmd(&self, cmd: RpcCommand) {
        let rpc = Arc::clone(&self.rpc);
        let tx = self.notice_tx.clone();
        tokio::spawn(async move {
            match rpc.send(&cmd).await {
                Ok(resp) if !resp.success => {
                    let _ = tx.send(format!(
                        "{} failed: {}",
                        cmd.command_type(),
                        resp.error.as_deref().unwrap_or("unknown error")
                    ));
                }
                Err(e) => {
                    let _ = tx.send(format!("{} send error: {e}", cmd.command_type()));
                }
                _ => {}
            }
        });
    }

    /// One frame: sync DOM → viewport → resolve → scroll → paint → ANSI.
    /// A fully unchanged frame (same sigs/scroll/size, no pending
    /// scrollback) skips painting entirely — the previous frame is
    /// still on screen, so the draw is a no-op.
    fn render_frame(&mut self) -> io::Result<()> {
        let mut out = String::new();
        if let Some(surface) = self.paint_frame() {
            // 7. Diff → ANSI, wrapped in synchronized output. The
            //    renderer hands back the replaced frame's surface for
            //    reuse as the next paint buffer.
            let frame = Frame::new(surface);
            ansi::begin_sync(&mut out);
            out.push_str(&self.renderer.draw(frame));
            ansi::end_sync(&mut out);
            if self.surface_spare.is_none() {
                self.surface_spare = self.renderer.spare_surface.take();
            }
        }
        // `setTitle` → OSC window-title escape (outside the sync block).
        if let Some(title) = self.state.term_title.take() {
            out.push_str(&format!("\x1b]2;{title}\x07"));
        }
        // agent_end → OSC 9 desktop notification (iTerm2/Windows Terminal;
        // terminals that don't know it ignore the sequence).
        if let Some(note) = self.state.term_notify.take() {
            out.push_str(&format!("\x1b]9;{note}\x07"));
        }

        let mut stdout = io::stdout().lock();
        stdout.write_all(out.as_bytes())?;
        stdout.flush()
    }

    /// Steps 1–6 of a frame at the current terminal size.
    /// Returns the painted surface, or `None` when nothing changed
    /// since the last painted frame (headless modes use `to_text` on it).
    pub fn paint_frame(&mut self) -> Option<Surface> {
        let (w, h) = self.term_size;
        self.paint_frame_at(w, h)
    }

    /// Steps 1–6 of a frame: DOM sync → layout → scroll → paint → cursor.
    ///
    /// Frame gating: DOM mutations only happen when inputs changed
    /// (component signature caches), `set_viewport`/`resolve` only when
    /// the size or DOM changed, and the paint surface is double-buffered
    /// instead of freshly allocated.
    pub fn paint_frame_at(&mut self, w: u16, h: u16) -> Option<Surface> {
        let dialog_sig = dialog::signature(&self.state);
        let completion_sig = completion::signature(&self.state);
        let todo_sig = todo::signature(&self.state);
        let input_sig = Self::input_signature(&self.state);
        let spinner_sig = Self::spinner_signature(&self.state);
        let status_sig = Self::status_signature(&self.state);
        let trace_sig = self.state.trace_signature();
        // Selection rect changes repaint without DOM sync.
        let sel_sig = {
            use std::hash::{Hash, Hasher};
            let mut s = std::collections::hash_map::DefaultHasher::new();
            self.state.sel_anchor.hash(&mut s);
            self.state.sel_head.hash(&mut s);
            s.finish()
        };
        let selection_dirty = sel_sig != self.sel_sig;
        let mut layout_dirty = self.state.dom_dirty
            || self.state.needs_rebuild
            || input_sig != self.input_sig
            || spinner_sig != self.spinner_sig
            || status_sig != self.status_sig
            || dialog_sig != self.dialog_sig
            || completion_sig != self.completion_sig
            || todo_sig != self.todo_sig
            || trace_sig != self.state.trace_sig
            || self.trace_open != self.state.trace_open;

        // Fully unchanged frame: no DOM mutation, same size, same
        // scroll, and the renderer has nothing pending — the previous
        // frame is still correct on screen.
        if !layout_dirty
            && !selection_dirty
            && (w, h) == self.last_viewport
            && self.state.scroll == self.painted_scroll
            && self.renderer.prev_frame.is_some()
            && self.renderer.pending.is_empty()
            && !self.renderer.needs_full_redraw
        {
            return None;
        }

        // 1. Patch the DOM from state — one mutate scope for
        //    everything, each sync gated by its input signature so an
        //    unchanged component costs zero DOM mutations.
        {
            let mut m = self.doc.mutate();
            if self.state.dom_dirty || self.state.needs_rebuild {
                message_list::sync(&mut m, self.handles.messages_inner, &mut self.state);
                self.state.dom_dirty = false;
            }
            if input_sig != self.input_sig {
                let hint = Self::input_hint(&self.state);
                input_box::sync(
                    &mut m,
                    self.handles.input_hint_text,
                    self.handles.input_text,
                    &self.state.input,
                    self.state.dialog.is_none(),
                    &hint,
                );
                self.input_sig = input_sig;
            }
            if status_sig != self.status_sig {
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
                self.status_sig = status_sig;
            }
            if spinner_sig != self.spinner_sig {
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
                    &self.theme.fusion(),
                );
                self.spinner_sig = spinner_sig;
            }
            if dialog_sig != self.dialog_sig {
                dialog::sync(
                    &mut m,
                    self.handles.dialog_area,
                    self.handles.widget_area,
                    self.handles.queue_area,
                    &self.state,
                    self.state.glyphs,
                );
                self.dialog_sig = dialog_sig;
            }
            if todo_sig != self.todo_sig {
                todo::sync(
                    &mut m,
                    self.handles.todo_area,
                    &self.state,
                    self.state.glyphs,
                );
                self.todo_sig = todo_sig;
            }
            if completion_sig != self.completion_sig {
                completion::sync(
                    &mut m,
                    self.handles.completion_area,
                    &self.state,
                    self.state.glyphs,
                );
                self.completion_sig = completion_sig;
            }

            // Thinking-trace overlay (F3): swap #messages-wrap for
            // #trace; content rebuilds only when thinking text changes.
            message_list::sync_trace(
                &mut m,
                self.handles.messages_wrap,
                self.handles.trace,
                self.handles.trace_text,
                &mut self.state,
                &mut self.trace_open,
            );

            // 2. Pin #app to the terminal size only when it changed
            //    (set_style_property parses + marks restyle damage).
            if (w, h) != self.last_viewport {
                m.set_style_property(self.handles.app, "width", &format!("{w}px"));
                m.set_style_property(self.handles.app, "height", &format!("{h}px"));
            }
            drop(m);
        }

        // 2b. Viewport: `set_viewport` rebuilds the stylo Device and
        //     re-evaluates media queries — only on actual resize.
        if (w, h) != self.last_viewport {
            self.doc.set_viewport(Viewport::new(
                w as u32,
                h as u32,
                1.0,
                self.theme_kind.color_scheme(),
            ));
            self.last_viewport = (w, h);
            layout_dirty = true;
        }

        // 3. Style + layout — skip entirely when nothing mutated
        //    (resolve still walks the whole DOM three times).
        if layout_dirty {
            self.doc.resolve(0.0);
        }

        // 4. Scroll clamp + write (messages + trace overlay).
        message_list::apply_scroll(
            &mut self.doc,
            self.handles.messages,
            self.handles.scrollbar_thumb,
            &mut self.state,
        );
        if self.state.trace_open {
            let (content_h, view_h) = self
                .doc
                .get_node(self.handles.trace)
                .map(|n| {
                    (
                        n.scrollable_overflow().height(),
                        n.final_layout().size.height as f64,
                    )
                })
                .unwrap_or((0.0, 0.0));
            let max = (content_h - view_h).max(0.0);
            self.state.trace_scroll = (self.state.trace_scroll as f64).min(max) as u32;
            if let Some(node) = self.doc.get_node_mut(self.handles.trace) {
                node.scroll_offset_mut().y = self.state.trace_scroll as f64;
            }
        }
        self.painted_scroll = self.state.scroll;
        self.messages_view_h = self
            .doc
            .get_node(self.handles.messages)
            .map(|n| n.final_layout().size.height as u32)
            .unwrap_or(0);

        // 5. Paint DOM → cell surface; keep the hit regions for mouse
        //    routing on the next event. Reuse the previous frame's
        //    buffer (double-buffered with the renderer).
        let mut surface = match self.surface_spare.take() {
            Some(mut s) if s.width == w && s.height == h => {
                s.reset();
                s
            }
            _ => Surface::new(w, h),
        };
        {
            let mut ctx = PaintContext::new(&self.doc, &mut surface);
            paint_document(&mut ctx);
            // Swap instead of take: the ctx Vec keeps its capacity for
            // the next frame.
            self.hit_regions.clear();
            std::mem::swap(&mut self.hit_regions, &mut ctx.hit_regions);
        }

        // 6. Cursor post-process: the PUA marker cell → inverse block.
        let cursor_cells: Vec<(u16, u16)> = surface
            .markers
            .iter()
            .filter(|m| m.text.contains(input_box::CURSOR_MARKER))
            .map(|m| (m.x, m.y))
            .collect();
        let cursor = self.theme.cursor_style();
        for (x, y) in cursor_cells {
            if let Some(cell) = surface.cell_mut(x, y) {
                cell.symbol = " ".into();
                cell.modifier |= cursor.modifier;
            }
        }

        // 7. Drag selection: INVERSE the region and refresh the
        //    copyable text under it (right-click → clipboard).
        self.state.sel_text = match (self.state.sel_anchor, self.state.sel_head) {
            (Some(a), Some(b)) if a != b => selection::apply(&mut surface, a, b),
            _ => String::new(),
        };
        self.sel_sig = sel_sig;

        Some(surface)
    }
}

/// pi-tui-style key id for a crossterm `KeyEvent` ("up", "escape", "f2",
/// or the character itself). Modifiers are reported separately via
/// `key_mods` — the pair is what `extension_ui_event` carries.
fn key_id(key: KeyEvent) -> String {
    match key.code {
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Enter => "enter".into(),
        KeyCode::Esc => "escape".into(),
        KeyCode::Tab => "tab".into(),
        KeyCode::BackTab => "backtab".into(),
        KeyCode::Backspace => "backspace".into(),
        KeyCode::Delete => "delete".into(),
        KeyCode::Insert => "insert".into(),
        KeyCode::Home => "home".into(),
        KeyCode::End => "end".into(),
        KeyCode::PageUp => "pageUp".into(),
        KeyCode::PageDown => "pageDown".into(),
        KeyCode::Up => "up".into(),
        KeyCode::Down => "down".into(),
        KeyCode::Left => "left".into(),
        KeyCode::Right => "right".into(),
        KeyCode::F(n) => format!("f{n}"),
        other => format!("{other:?}").to_lowercase(),
    }
}

/// Active modifier names for `UiEvent::Key.mods`.
fn key_mods(key: KeyEvent) -> Vec<String> {
    let mut mods = Vec::new();
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        mods.push("ctrl".into());
    }
    if key.modifiers.contains(KeyModifiers::ALT) {
        mods.push("alt".into());
    }
    if key.modifiers.contains(KeyModifiers::SHIFT) {
        mods.push("shift".into());
    }
    mods
}

/// Shared line-editing keys for dialog input/editor fields — the same
/// Emacs ops as the main input (word nav, kill ring, transpose, case).
fn edit_keys(input: &mut crate::state::InputState, key: KeyEvent) {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    if alt {
        match key.code {
            KeyCode::Char('b') | KeyCode::Char('B') => input.move_word_left(),
            KeyCode::Char('f') | KeyCode::Char('F') => input.move_word_right(),
            KeyCode::Char('d') | KeyCode::Char('D') => input.kill_word(),
            KeyCode::Char('u') | KeyCode::Char('U') => {
                input.case_word(crate::state::WordCase::Upper)
            }
            KeyCode::Char('l') | KeyCode::Char('L') => {
                input.case_word(crate::state::WordCase::Lower)
            }
            KeyCode::Char('c') | KeyCode::Char('C') => {
                input.case_word(crate::state::WordCase::Capitalize)
            }
            KeyCode::Char('t') | KeyCode::Char('T') => input.transpose_words(),
            KeyCode::Char('y') | KeyCode::Char('Y') => input.yank_pop(),
            KeyCode::Backspace => input.backward_kill_word(),
            KeyCode::Char(c) => input.insert_char(c),
            _ => {}
        }
        return;
    }
    match (key.code, ctrl) {
        (KeyCode::Char('z') | KeyCode::Char('Z'), true) if shift => input.redo(),
        (KeyCode::Char('z') | KeyCode::Char('Z'), true) | (KeyCode::Char('_'), true) => {
            input.undo()
        }
        (KeyCode::Backspace, true) => input.backward_kill_word(),
        (KeyCode::Backspace, _) => input.backspace(),
        (KeyCode::Delete, _) => input.delete(),
        (KeyCode::Left, true) => input.move_word_left(),
        (KeyCode::Left, _) => input.move_left(),
        (KeyCode::Right, true) => input.move_word_right(),
        (KeyCode::Right, false) if input.cursor == input.text.len() && input.ghost.is_some() => {
            input.accept_ghost();
        }
        (KeyCode::Right, _) => input.move_right(),
        (KeyCode::Home, _) => input.move_home(),
        (KeyCode::End, _) if input.ghost.is_some() => {
            input.accept_ghost();
        }
        (KeyCode::End, _) => input.move_end(),
        (KeyCode::Up, _) => {
            input.prev_line();
        }
        (KeyCode::Down, _) => {
            input.next_line();
        }
        (KeyCode::Char('a'), true) => input.move_home(),
        (KeyCode::Char('e'), true) => input.move_end(),
        (KeyCode::Char('f'), true) => input.move_right(),
        (KeyCode::Char('b'), true) => input.move_left(),
        (KeyCode::Char('h'), true) => input.backspace(),
        (KeyCode::Char('d'), true) => input.delete(),
        (KeyCode::Char('k'), true) => input.kill_line(),
        (KeyCode::Char('u'), true) => input.backward_kill_line(),
        (KeyCode::Char('w'), true) => input.unix_word_rubout(),
        (KeyCode::Char('y'), true) => input.yank(),
        (KeyCode::Char('t'), true) => input.transpose_chars(),
        (KeyCode::Char('r'), true) => input.history_search(),
        (KeyCode::Char(c), false) => input.insert_char(c),
        _ => {}
    }
}

/// Open a URL in the system browser (best-effort, fire-and-forget).
fn open_url(url: &str) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

/// Build the static DOM skeleton: `html > body > #app > (#messages,
/// #spinner-line, #dialog-area, #widget-area, #input-area,
/// #completion-area, #status-line)`. Returns the handles the app patches.
pub fn build_skeleton(doc: &mut BaseDocument) -> DomHandles {
    use crate::components::dom::{div, qual};

    let root = doc.root_node().id;
    let mut m = doc.mutate();

    let html = m.create_element(qual("html"), vec![]);
    m.append_children(root, &[html]);
    let body = m.create_element(qual("body"), vec![]);
    m.append_children(html, &[body]);
    let app = div(&mut m, body, "");
    m.set_attribute(app, qual("id"), "app");

    let (messages_wrap, messages, messages_inner, scrollbar_thumb) =
        message_list::build(&mut m, app);
    // Thinking-trace overlay: sibling of the wrap, hidden by default.
    let trace = div(&mut m, app, "");
    m.set_attribute(trace, qual("id"), "trace");
    let trace_text = m.create_text_node("");
    m.append_children(trace, &[trace_text]);
    let spinner = spinner::build(&mut m, app);
    let queue_area = div(&mut m, app, "");
    m.set_attribute(queue_area, qual("id"), "queue-area");
    let todo_area = div(&mut m, app, "");
    m.set_attribute(todo_area, qual("id"), "todo-area");
    let (dialog_area, widget_area) = dialog::build(&mut m, app);
    let (_area, hint_text, input_text) = input_box::build(&mut m, app);
    let completion_area = completion::build(&mut m, app);
    let status = status_line::build(&mut m, app);

    drop(m);

    DomHandles {
        root,
        app,
        messages,
        messages_inner,
        scrollbar_thumb,
        messages_wrap,
        trace,
        trace_text,
        spinner,
        queue_area,
        todo_area,
        dialog_area,
        widget_area,
        input_hint_text: hint_text,
        input_text,
        completion_area,
        status,
    }
}

/// Enter alt-screen, raw mode, hide cursor, enable paste + mouse scroll.
fn terminal_setup_enter() -> io::Result<()> {
    terminal::enable_raw_mode()?;
    let mut out = io::stdout().lock();
    execute!(
        out,
        EnableBracketedPaste,
        EnableMouseCapture,
        terminal::EnterAlternateScreen,
        crossterm::cursor::Hide,
    )?;
    out.flush()
}

/// Leave alt-screen, restore cursor, disable raw mode.
fn terminal_setup_leave() -> io::Result<()> {
    let mut out = io::stdout().lock();
    let _ = execute!(
        out,
        crossterm::cursor::Show,
        terminal::LeaveAlternateScreen,
        DisableMouseCapture,
        DisableBracketedPaste,
    );
    let _ = out.flush();
    terminal::disable_raw_mode()
}

/// Parse a thinking-level name (`off|minimal|low|medium|high|xhigh|max`).
fn parse_thinking_level(s: &str) -> Option<pi_rpc::ThinkingLevel> {
    use pi_rpc::ThinkingLevel as T;
    match s.to_ascii_lowercase().as_str() {
        "off" => Some(T::Off),
        "minimal" | "min" => Some(T::Minimal),
        "low" => Some(T::Low),
        "medium" | "med" => Some(T::Medium),
        "high" => Some(T::High),
        "xhigh" | "x-high" => Some(T::Xhigh),
        "max" => Some(T::Max),
        _ => None,
    }
}

/// `/copy` — write text to the system clipboard.
fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}

impl App {
    /// Ctrl+V: clipboard image → attachment; text → insert.
    fn paste_clipboard(&mut self) {
        let mut cb = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(e) => {
                self.state.push_system(format!("clipboard: {e}"));
                return;
            }
        };
        if let Ok(img) = cb.get_image() {
            match encode_png(&img) {
                Ok(png) => {
                    let n = self.state.attachments.len() + 1;
                    self.state.attachments.push(crate::state::Attachment {
                        data: base64::Engine::encode(
                            &base64::engine::general_purpose::STANDARD,
                            png,
                        ),
                        mime: "image/png".into(),
                        label: format!("image {n}"),
                    });
                    self.state.push_system(format!("attached image {n}"));
                }
                Err(e) => self.state.push_system(format!("image encode: {e}")),
            }
        } else if let Ok(text) = cb.get_text() {
            let text = text.replace("\r\n", "\n").replace('\r', "\n");
            self.state.input.insert_str(&text);
        }
        self.state.dom_dirty = true;
    }

    /// Ctrl+G: edit the input in $EDITOR (RECON `open_external_editor`).
    /// Leaves the alt-screen, blocks on the editor, restores.
    fn open_external_editor(&mut self) {
        let editor = std::env::var("EDITOR")
            .or_else(|_| std::env::var("VISUAL"))
            .unwrap_or_else(|_| "notepad".into());
        let path = std::env::temp_dir().join("pi-tui-input.md");
        if std::fs::write(&path, &self.state.input.text).is_err() {
            self.state.push_system("cannot write temp file");
            return;
        }
        let _ = terminal_setup_leave();
        let status = std::process::Command::new(&editor).arg(&path).status();
        let _ = terminal_setup_enter();
        match status {
            Ok(s) if s.success() => {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    self.state.input.text = text.trim_end().to_string();
                    self.state.input.cursor = self.state.input.text.len();
                }
            }
            Ok(_) => self.state.push_system("editor exited non-zero"),
            Err(e) => self.state.push_system(format!("editor '{editor}': {e}")),
        }
        self.renderer.needs_full_redraw = true;
        self.state.dom_dirty = true;
    }
}

/// Encode RGBA8 clipboard pixels as PNG.
fn encode_png(img: &arboard::ImageData<'_>) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, img.width as u32, img.height as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(&img.bytes).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streaming_submit_selects_steer_or_follow_up() {
        assert!(matches!(
            streaming_input_command(Some(StreamingBehavior::Steer), "now".into(), None),
            RpcCommand::Steer { message, .. } if message == "now"
        ));
        assert!(matches!(
            streaming_input_command(Some(StreamingBehavior::FollowUp), "later".into(), None),
            RpcCommand::FollowUp { message, .. } if message == "later"
        ));
        assert!(matches!(
            streaming_input_command(None, "default".into(), None),
            RpcCommand::FollowUp { .. }
        ));
    }
}

/// Build the `@` file index: cwd-relative paths, gitignore-aware
/// (`ignore` crate), hidden files included except `.git`.
fn build_file_index(state: &crate::state::AppState) -> Vec<String> {
    let include_gitignored = state
        .settings
        .get("include_gitignored_in_mentions")
        .copied()
        .unwrap_or(false);
    let mut wb = ignore::WalkBuilder::new(".");
    wb.hidden(false)
        .git_ignore(!include_gitignored)
        .git_global(!include_gitignored)
        .git_exclude(!include_gitignored)
        .filter_entry(|e| e.file_name() != ".git");
    let mut files = Vec::new();
    for entry in wb.build().flatten() {
        if entry.file_type().is_some_and(|t| t.is_file()) {
            let p = entry.path();
            let s = p.strip_prefix(".").unwrap_or(p).to_string_lossy();
            files.push(s.trim_start_matches(['/', '\\']).replace('\\', "/"));
        }
        if files.len() >= 20_000 {
            break;
        }
    }
    files.sort();
    files
}
