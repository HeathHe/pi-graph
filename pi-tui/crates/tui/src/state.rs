//! `state` — application state model + `RpcEvent` → state reduction.
//!
//! The DOM is a *projection* of this state: `app.rs` rebuilds/patches the
//! DOM from `AppState` each time it changes. Streaming text deltas update
//! the last message's text node in place (`set_node_text`); structural
//! changes (new message, tool lifecycle) append/remove nodes.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use pi_rpc::events::{is_run_end, text_delta, thinking_delta};
use pi_rpc::types::{
    AgentEvent, AgentMessage, AssistantMessageEvent, MessageContent, Model, RpcResponse,
    StreamingBehavior, ThinkingLevel, UserContent,
};
use pi_rpc::{
    Frame, OverlayDriver, OverlaySpec, RpcEvent, RpcExtensionUIRequest, RpcExtensionUIResponse,
};

use crate::components::glyphs::GlyphMode;
use crate::components::select::SelectState;
use crate::theme::ThemeKind;

/// What kind of bubble a message renders as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MsgKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Error,
    System,
    Compaction,
    Branch,
    Skill,
    Custom,
}

/// One entry in the message list.
#[derive(Clone, Debug)]
pub struct Message {
    pub kind: MsgKind,
    /// Primary text content (streamed for assistant/thinking); for tools,
    /// the args summary shown in the card header.
    pub text: String,
    /// Tool name for `MsgKind::Tool`.
    pub tool_name: Option<String>,
    /// `toolCallId` — matches execution_update/end to the right card
    /// (nested tools interleave, so `last_mut` is wrong).
    pub tool_call_id: Option<String>,
    /// Index into `state.tray.entries` when this card is a subagent/
    /// shell spawn (drives the in-card activity feed).
    pub tray_entry: Option<usize>,
    /// Index of the tray entry this card is nested under (a tool that
    /// ran inside a subagent). Backgrounded owners hide the card.
    pub nested_under: Option<usize>,
    /// Tool status glyph: `●` running, `✓` ok, `✗` error, `◔` partial.
    pub tool_status: Option<char>,
    /// Full tool output (`tool_execution_end` result) — rendered as the
    /// card body, truncated unless `expanded`.
    pub tool_output: Option<String>,
    /// Raw tool args (kept for `detect_lang` + the Devin-style
    /// `$ command` body line at execution end).
    pub tool_args: Option<serde_json::Value>,
    /// Shell exit code extracted from the tool result (bash).
    pub tool_exit: Option<i64>,
    /// Detected output language (`tool_card::detect_lang`).
    pub tool_lang: Option<&'static str>,
    /// Ctrl+O / click-expand: show full tool output.
    pub expanded: bool,
    /// DOM node id of the bubble element (set by the DOM builder).
    pub node_id: Option<blitz_dom::NodeId>,
    /// DOM node id of the primary text node inside the bubble.
    pub text_node_id: Option<blitz_dom::NodeId>,
    /// DOM node id of the tool glyph text node (MsgKind::Tool only).
    pub glyph_node_id: Option<blitz_dom::NodeId>,
    /// Sealed bubbles no longer accept streamed appends (set at turn_end).
    pub sealed: bool,
    /// Structural rebuild requested (tool card state changed).
    pub dirty: bool,
    /// Length of `text` already rendered into the DOM (markdown/tool
    /// rebuilds compare against this to skip no-op work).
    pub rendered_len: usize,
    /// App tick of the last structural re-render — streamed appends
    /// throttle to `STREAM_RENDER_INTERVAL` ticks so a long markdown
    /// message isn't re-parsed per delta (O(len²) per message).
    pub last_render_tick: u64,
    /// Search-hit mark applied to the bubble class (render-only; the
    /// message text is never mutated).
    pub search_mark: SearchMark,
    /// The mark currently baked into the DOM class — `message_list::sync`
    /// rewrites the class attribute when these diverge.
    pub rendered_search_mark: SearchMark,
}

/// Scrollback-search highlight state of one bubble.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SearchMark {
    #[default]
    None,
    /// Message matches the active query.
    Hit,
    /// The match the cursor is currently on.
    Current,
}

impl Message {
    /// New message bubble of `kind` with `text`.
    pub fn new(kind: MsgKind, text: impl Into<String>) -> Self {
        Message {
            kind,
            text: text.into(),
            tool_name: None,
            tool_call_id: None,
            tray_entry: None,
            nested_under: None,
            tool_status: None,
            tool_output: None,
            tool_args: None,
            tool_exit: None,
            tool_lang: None,
            expanded: false,
            node_id: None,
            text_node_id: None,
            glyph_node_id: None,
            sealed: false,
            dirty: false,
            rendered_len: 0,
            last_render_tick: 0,
            search_mark: SearchMark::None,
            rendered_search_mark: SearchMark::None,
        }
    }
}

/// Input box editing state (Emacs-style line editing + kill ring).
#[derive(Clone, Debug, Default)]
pub struct InputState {
    /// Current input text (may contain newlines).
    pub text: String,
    /// Cursor position as a *byte* index (always on a char boundary).
    pub cursor: usize,
    /// Submitted prompt history (oldest → newest).
    pub history: Vec<String>,
    /// `Some(i)` while navigating history; `history[i]` is shown.
    pub history_idx: Option<usize>,
    /// Stash of the in-progress input while browsing history.
    pub history_stash: String,
    /// Kill ring: text removed by kill_* ops (oldest → newest).
    pub kill_ring: Vec<String>,
    /// Display-only suffix from the newest history entry matching `text`.
    pub ghost: Option<String>,
    /// Text/cursor snapshots captured before edits (oldest → newest).
    undo_stack: Vec<(String, usize)>,
    /// Text/cursor snapshots made available by undo.
    redo_stack: Vec<(String, usize)>,
    /// Region and kill-ring index installed by the latest yank/yank-pop.
    last_yank: Option<(usize, usize, usize)>,
    /// Time and resulting cursor of the latest coalescible char insert.
    last_insert: Option<(Instant, usize)>,
}

/// Emacs word-case transform applied to the word after the cursor.
#[derive(Clone, Copy, Debug)]
pub enum WordCase {
    Upper,
    Lower,
    Capitalize,
}

/// Max kill-ring depth (Emacs default is 60).
const KILL_RING_MAX: usize = 60;
/// Bound retained editor history so long sessions do not grow forever.
const UNDO_STACK_MAX: usize = 100;
/// Adjacent character inserts within this window form one undo step.
const INSERT_COALESCE_WINDOW: Duration = Duration::from_millis(500);

/// Emacs word constituent: alphanumerics plus `_`.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl InputState {
    fn push_snapshot(stack: &mut Vec<(String, usize)>, snapshot: (String, usize)) {
        stack.push(snapshot);
        if stack.len() > UNDO_STACK_MAX {
            stack.remove(0);
        }
    }

    /// Capture the current text/cursor before an edit. Character inserts
    /// coalesce only while they remain adjacent and arrive close together.
    fn record_edit(&mut self, coalesce_insert: bool) {
        let coalesce = coalesce_insert
            && self.last_insert.is_some_and(|(at, cursor)| {
                cursor == self.cursor && at.elapsed() < INSERT_COALESCE_WINDOW
            });
        if !coalesce {
            Self::push_snapshot(&mut self.undo_stack, (self.text.clone(), self.cursor));
        }
        self.redo_stack.clear();
        self.last_yank = None;
        self.ghost = None;
        if !coalesce_insert {
            self.last_insert = None;
        }
    }

    /// Restore the most recent pre-edit snapshot.
    pub fn undo(&mut self) {
        let Some(snapshot) = self.undo_stack.pop() else {
            return;
        };
        Self::push_snapshot(&mut self.redo_stack, (self.text.clone(), self.cursor));
        (self.text, self.cursor) = snapshot;
        self.history_idx = None;
        self.history_stash.clear();
        self.last_yank = None;
        self.last_insert = None;
        self.ghost = None;
    }

    /// Reapply the most recently undone snapshot.
    pub fn redo(&mut self) {
        let Some(snapshot) = self.redo_stack.pop() else {
            return;
        };
        Self::push_snapshot(&mut self.undo_stack, (self.text.clone(), self.cursor));
        (self.text, self.cursor) = snapshot;
        self.history_idx = None;
        self.history_stash.clear();
        self.last_yank = None;
        self.last_insert = None;
        self.ghost = None;
    }

    /// Byte index of the next char boundary at/after `pos + 1`.
    fn next_boundary_at(&self, pos: usize) -> usize {
        let mut i = pos + 1;
        while i < self.text.len() && !self.text.is_char_boundary(i) {
            i += 1;
        }
        i.min(self.text.len())
    }

    /// Byte index of the previous char boundary before `pos`.
    fn prev_boundary_at(&self, pos: usize) -> usize {
        if pos == 0 {
            return 0;
        }
        let mut i = pos - 1;
        while i > 0 && !self.text.is_char_boundary(i) {
            i -= 1;
        }
        i
    }

    fn next_boundary(&self) -> usize {
        self.next_boundary_at(self.cursor)
    }

    fn prev_boundary(&self) -> usize {
        self.prev_boundary_at(self.cursor)
    }

    /// Byte index of the char-boundary `n` chars after `pos`.
    fn nth_char_pos(&self, pos: usize, n: usize) -> usize {
        let mut i = pos;
        for _ in 0..n {
            if i >= self.text.len() {
                return self.text.len();
            }
            i = self.next_boundary_at(i);
        }
        i
    }

    /// Byte index of the start of the line containing `pos`.
    fn line_start(&self, pos: usize) -> usize {
        self.text[..pos].rfind('\n').map_or(0, |i| i + 1)
    }

    /// Byte index of the end of the line containing `pos` (the `\n` or EOF).
    fn line_end(&self, pos: usize) -> usize {
        self.text[pos..]
            .find('\n')
            .map_or(self.text.len(), |i| pos + i)
    }

    /// Cursor column in *chars* within its line.
    fn cursor_col(&self) -> usize {
        self.text[self.line_start(self.cursor)..self.cursor]
            .chars()
            .count()
    }

    /// Any text mutation exits history-browse mode (the recalled entry
    /// becomes the new in-progress input).
    fn touch(&mut self) {
        self.history_idx = None;
        self.history_stash.clear();
    }

    /// Push killed text onto the ring.
    fn push_kill(&mut self, s: String) {
        if s.is_empty() {
            return;
        }
        self.kill_ring.push(s);
        if self.kill_ring.len() > KILL_RING_MAX {
            self.kill_ring.remove(0);
        }
    }

    /// Remove `start..end`, push it on the kill ring, place the cursor.
    fn kill_range(&mut self, start: usize, end: usize) {
        if start >= end {
            return;
        }
        self.record_edit(false);
        let killed = self.text[start..end].to_string();
        self.text.replace_range(start..end, "");
        self.cursor = start;
        self.push_kill(killed);
        self.touch();
    }

    /// Emacs forward-word: skip non-word chars, then the word run.
    fn word_forward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if !is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        i
    }

    /// Emacs backward-word: skip non-word chars back, then the word run.
    fn word_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if !is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        i
    }

    /// End boundary of the word before `pos` (skips non-word chars
    /// back; returns `pos` when already at a word end).
    fn word_end_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if is_word_char(self.text[p..i].chars().next().unwrap()) {
                break;
            }
            i = p;
        }
        i
    }

    /// unix-word-rubout word: whitespace-delimited, backwards.
    fn unix_word_backward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if !self.text[p..i].chars().next().unwrap().is_whitespace() {
                break;
            }
            i = p;
        }
        while i > 0 {
            let p = self.prev_boundary_at(i);
            if self.text[p..i].chars().next().unwrap().is_whitespace() {
                break;
            }
            i = p;
        }
        i
    }

    pub fn insert_str(&mut self, s: &str) {
        if s.is_empty() {
            return;
        }
        self.record_edit(false);
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.touch();
    }

    pub fn insert_char(&mut self, c: char) {
        self.record_edit(true);
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        self.touch();
        self.last_insert = Some((Instant::now(), self.cursor));
    }

    /// Accept the currently displayed passive history suffix.
    pub fn accept_ghost(&mut self) -> bool {
        let Some(suffix) = self.ghost.take() else {
            return false;
        };
        self.insert_str(&suffix);
        true
    }

    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.record_edit(false);
            let prev = self.prev_boundary();
            self.text.replace_range(prev..self.cursor, "");
            self.cursor = prev;
            self.touch();
        }
    }

    pub fn delete(&mut self) {
        if self.cursor < self.text.len() {
            self.record_edit(false);
            let next = self.next_boundary();
            self.text.replace_range(self.cursor..next, "");
            self.touch();
        }
    }

    pub fn move_left(&mut self) {
        self.cursor = self.prev_boundary();
    }

    pub fn move_right(&mut self) {
        self.cursor = self.next_boundary();
    }

    /// Emacs move-beginning-of-line (Ctrl+A / Home).
    pub fn move_home(&mut self) {
        self.cursor = self.line_start(self.cursor);
    }

    /// Emacs move-end-of-line (Ctrl+E / End).
    pub fn move_end(&mut self) {
        self.cursor = self.line_end(self.cursor);
    }

    /// Emacs forward-word (Alt+F / Ctrl+Right).
    pub fn move_word_right(&mut self) {
        self.cursor = self.word_forward(self.cursor);
    }

    /// Emacs backward-word (Alt+B / Ctrl+Left).
    pub fn move_word_left(&mut self) {
        self.cursor = self.word_backward(self.cursor);
    }

    /// Move up one logical line, same column. Returns false on the
    /// first line (caller falls back to history).
    pub fn prev_line(&mut self) -> bool {
        let start = self.line_start(self.cursor);
        if start == 0 {
            return false;
        }
        let col = self.cursor_col();
        let prev_end = start - 1;
        let prev_start = self.line_start(prev_end);
        let prev_len = self.text[prev_start..prev_end].chars().count();
        self.cursor = self.nth_char_pos(prev_start, col.min(prev_len));
        true
    }

    /// Move down one logical line, same column. Returns false on the
    /// last line (caller falls back to history).
    pub fn next_line(&mut self) -> bool {
        let end = self.line_end(self.cursor);
        if end >= self.text.len() {
            return false;
        }
        let col = self.cursor_col();
        let next_start = end + 1;
        let next_end = self.line_end(next_start);
        let next_len = self.text[next_start..next_end].chars().count();
        self.cursor = self.nth_char_pos(next_start, col.min(next_len));
        true
    }

    /// Emacs kill-line (Ctrl+K): to end of line; at EOL kills the `\n`.
    pub fn kill_line(&mut self) {
        let end = self.line_end(self.cursor);
        if end == self.cursor {
            if self.cursor < self.text.len() {
                self.kill_range(self.cursor, self.cursor + 1);
            }
        } else {
            self.kill_range(self.cursor, end);
        }
    }

    /// Emacs backward-kill-line (Ctrl+U): to start of line.
    pub fn backward_kill_line(&mut self) {
        let start = self.line_start(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// Emacs kill-word (Alt+D).
    pub fn kill_word(&mut self) {
        let end = self.word_forward(self.cursor);
        self.kill_range(self.cursor, end);
    }

    /// Emacs backward-kill-word (Alt+Backspace / Ctrl+Backspace).
    pub fn backward_kill_word(&mut self) {
        let start = self.word_backward(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// unix-word-rubout (Ctrl+W): kill the whitespace-delimited word.
    pub fn unix_word_rubout(&mut self) {
        let start = self.unix_word_backward(self.cursor);
        self.kill_range(start, self.cursor);
    }

    /// Emacs yank (Ctrl+Y): insert the most recent kill.
    pub fn yank(&mut self) {
        if let Some((ring_idx, s)) = self
            .kill_ring
            .len()
            .checked_sub(1)
            .and_then(|idx| self.kill_ring.get(idx).cloned().map(|s| (idx, s)))
        {
            self.record_edit(false);
            let start = self.cursor;
            self.text.insert_str(start, &s);
            self.cursor += s.len();
            self.touch();
            self.last_yank = Some((start, self.cursor, ring_idx));
        }
    }

    /// Emacs yank-pop (Alt+Y): replace the last yank with the previous
    /// kill-ring entry, cycling through the ring.
    pub fn yank_pop(&mut self) {
        let Some((start, end, ring_idx)) = self.last_yank else {
            return;
        };
        if self.kill_ring.len() < 2 || end > self.text.len() {
            return;
        }
        let next_idx = if ring_idx == 0 {
            self.kill_ring.len() - 1
        } else {
            ring_idx - 1
        };
        let replacement = self.kill_ring[next_idx].clone();
        self.record_edit(false);
        self.text.replace_range(start..end, &replacement);
        self.cursor = start + replacement.len();
        self.touch();
        self.last_yank = Some((start, self.cursor, next_idx));
    }

    /// Emacs transpose-chars (Ctrl+T).
    pub fn transpose_chars(&mut self) {
        let len = self.text.len();
        if len == 0 || self.text[..len].chars().count() < 2 {
            return;
        }
        // At EOL Emacs swaps the two chars before point.
        let (i, j) = if self.cursor == 0 {
            return;
        } else if self.cursor >= len {
            (
                self.prev_boundary_at(self.prev_boundary_at(len)),
                self.prev_boundary_at(len),
            )
        } else {
            (self.prev_boundary(), self.cursor)
        };
        let k = self.next_boundary_at(j);
        let a = self.text[i..j].to_string();
        let b = self.text[j..k].to_string();
        self.record_edit(false);
        self.text.replace_range(i..k, &format!("{b}{a}"));
        self.cursor = k;
        self.touch();
    }

    /// First word-char boundary at/after `pos` (skips non-word chars).
    fn word_start_forward(&self, pos: usize) -> usize {
        let mut i = pos;
        while i < self.text.len() {
            let c = self.text[i..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            i += c.len_utf8();
        }
        i
    }

    /// Emacs transpose-words (Alt+T): drag the word before point past
    /// the word after point.
    pub fn transpose_words(&mut self) {
        // w1 = word ending at/after point (or the previous word when
        // point sits between words); w2 = the next word after it.
        let mut w1e = if self.cursor > 0
            && is_word_char(
                self.text[self.prev_boundary()..self.cursor]
                    .chars()
                    .next()
                    .unwrap(),
            ) {
            self.word_forward(self.cursor)
        } else {
            self.word_end_backward(self.cursor)
        };
        let mut w1s = self.word_backward(w1e);
        let mut w2s = self.word_start_forward(w1e);
        let mut w2e = self.word_forward(w2s);
        if w1s >= w1e && w2s < w2e {
            // BOB: no word before point — transpose the two after.
            w1s = w2s;
            w1e = w2e;
            w2s = self.word_start_forward(w1e);
            w2e = self.word_forward(w2s);
        } else if w2s >= w2e && w1s < w1e {
            // EOB: no word after point — transpose the two before.
            w2s = w1s;
            w2e = w1e;
            w1e = self.word_end_backward(w1s);
            w1s = self.word_backward(w1e);
        }
        if w1s >= w1e || w1e > w2s || w2s >= w2e {
            return;
        }
        let a = self.text[w1s..w1e].to_string();
        let mid = self.text[w1e..w2s].to_string();
        let b = self.text[w2s..w2e].to_string();
        self.record_edit(false);
        self.text.replace_range(w1s..w2e, &format!("{b}{mid}{a}"));
        self.cursor = w2e;
        self.touch();
    }

    /// Emacs upcase/downcase/capitalize-word (Alt+U / Alt+L / Alt+C).
    pub fn case_word(&mut self, case: WordCase) {
        let start = self.word_forward(self.cursor);
        // word_forward lands at the word *end*; the word starts at the
        // first word-char at/after the original cursor.
        let mut s = self.cursor;
        while s < self.text.len() {
            let c = self.text[s..].chars().next().unwrap();
            if is_word_char(c) {
                break;
            }
            s += c.len_utf8();
        }
        if s >= start {
            self.cursor = start;
            return;
        }
        let word = &self.text[s..start];
        let new: String = match case {
            WordCase::Upper => word.chars().flat_map(char::to_uppercase).collect(),
            WordCase::Lower => word.chars().flat_map(char::to_lowercase).collect(),
            WordCase::Capitalize => {
                let mut it = word.chars();
                match it.next() {
                    Some(c) => c
                        .to_uppercase()
                        .chain(it.flat_map(char::to_lowercase))
                        .collect(),
                    None => String::new(),
                }
            }
        };
        self.record_edit(false);
        self.text.replace_range(s..start, &new);
        self.cursor = s + new.len();
        self.touch();
    }

    /// Ctrl+R: recall the previous history entry containing the
    /// in-progress text (repeating steps further back).
    pub fn history_search(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let (query, start) = match self.history_idx {
            Some(i) => (self.history_stash.clone(), i),
            None => {
                self.history_stash = self.text.clone();
                (self.history_stash.clone(), self.history.len())
            }
        };
        for i in (0..start).rev() {
            if self.history[i].contains(&query) {
                self.history_idx = Some(i);
                self.text = self.history[i].clone();
                self.cursor = self.text.len();
                return;
            }
        }
    }

    /// Take the input for submission, pushing it onto history.
    pub fn take_submitted(&mut self) -> String {
        let text = std::mem::take(&mut self.text);
        self.cursor = 0;
        self.history_idx = None;
        self.history_stash.clear();
        if !text.trim().is_empty() {
            self.history.push(text.clone());
        }
        text
    }

    /// Up: recall an older history entry.
    pub fn history_up(&mut self) {
        if self.history.is_empty() {
            return;
        }
        match self.history_idx {
            None => {
                self.history_stash = self.text.clone();
                self.history_idx = Some(self.history.len() - 1);
            }
            Some(0) => return,
            Some(i) => self.history_idx = Some(i - 1),
        }
        self.text = self.history[self.history_idx.unwrap()].clone();
        self.cursor = self.text.len();
    }

    /// Down: recall a newer history entry, or restore the stash.
    pub fn history_down(&mut self) {
        let Some(i) = self.history_idx else { return };
        if i + 1 < self.history.len() {
            self.history_idx = Some(i + 1);
            self.text = self.history[i + 1].clone();
        } else {
            self.history_idx = None;
            self.text = std::mem::take(&mut self.history_stash);
        }
        self.cursor = self.text.len();
    }
}

/// Session metadata shown in the status line.
#[derive(Clone, Debug, Default)]
pub struct StatusState {
    pub model: String,
    pub thinking: String,
    pub mode: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Latest assistant `totalTokens` — context occupancy numerator.
    pub context_tokens: u64,
    /// Active model's `contextWindow` (0 = unknown → bar hidden).
    pub context_window: u64,
    /// Accumulated USD across assistant `message_end` usage.
    pub cost: f64,
    /// Working directory and git branch — local facts, no RPC needed.
    pub cwd: String,
    pub git_branch: String,
    /// Extra transient status (e.g. "compacting…", "retrying 2/5").
    pub transient: String,
}

/// Permission modes (RECON §9 tips: `Shift+Tab to cycle permission
/// modes`). Displayed in the status line; pi-rpc has no permission
/// command, so this is a local UI mode for now.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PermissionMode {
    #[default]
    Normal,
    AcceptEdits,
    Smart,
    Plan,
    Ask,
    Bypass,
    Autonomous,
}

impl PermissionMode {
    /// `Shift+Tab` cycles forward through the modes.
    pub fn next(self) -> Self {
        match self {
            Self::Normal => Self::AcceptEdits,
            Self::AcceptEdits => Self::Smart,
            Self::Smart => Self::Plan,
            Self::Plan => Self::Ask,
            Self::Ask => Self::Bypass,
            Self::Bypass => Self::Autonomous,
            Self::Autonomous => Self::Normal,
        }
    }

    /// Status-line label.
    pub fn label(self) -> &'static str {
        match self {
            Self::Normal => "NORMAL",
            Self::AcceptEdits => "ACCEPT EDITS",
            Self::Smart => "SMART",
            Self::Plan => "PLAN",
            Self::Ask => "ASK",
            Self::Bypass => "BYPASS",
            Self::Autonomous => "AUTONOMOUS",
        }
    }
}

/// A transient notification (`notify` extension UI request).
#[derive(Clone, Debug)]
pub struct Toast {
    pub text: String,
    /// Remaining app ticks before auto-dismiss.
    pub ticks_left: u64,
}

/// The active extension-UI dialog (one at a time; extras queue).
#[derive(Clone, Debug)]
pub enum DialogState {
    Select {
        id: String,
        sel: SelectState,
    },
    Confirm {
        id: String,
        title: String,
        message: String,
    },
    Input {
        id: String,
        title: String,
        placeholder: Option<String>,
        input: InputState,
    },
    Editor {
        id: String,
        title: String,
        input: InputState,
    },
    /// A locally-opened picker (model / thinking level). Resolving it
    /// dispatches a local action instead of an `extension_ui_response`.
    Local {
        sel: SelectState,
        action: LocalAction,
    },
    /// A plugin overlay (`method:"custom"`). `driver:Plugin` streams frames
    /// and consumes `extension_ui_event` input; `driver:Client` renders the
    /// spec's declarative fields (P3) and resolves with a response.
    Plugin {
        id: String,
        spec: OverlaySpec,
        driver: OverlayDriver,
        /// Latest body frame (plugin-driven); empty until the first
        /// `overlay_frame` arrives.
        frame: Frame,
        /// Optional cursor cell (row, col) inside the body.
        cursor: Option<(u16, u16)>,
    },
}

/// What a resolved `DialogState::Local` should do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalAction {
    /// Send `set_model` for the selected entry in `state.models`.
    SetModel,
    /// Send `set_thinking_level` for the selected level.
    SetThinking,
    /// Toggle the boolean setting at the selected row (stays open).
    ToggleSetting,
    /// Fork from an entry returned by `get_entries` (`/resume`).
    ResumeEntry,
    /// Fork from a node returned by `get_tree`.
    TreeEntry,
    /// Fork from a user message returned by `get_fork_messages`.
    ForkEntry,
    /// Apply the selected color theme (`/theme` picker, live preview).
    SetTheme,
}

/// `/settings` — live local toggles (RECON §12.5 config keys).
/// `startup_tips_remaining` is intentionally a boolean proxy for the
/// startup banner rather than a persisted numeric counter.
pub const SETTINGS_KEYS: [&str; 8] = [
    "subagents_enabled",
    "show_tips",
    "mouse_capture",
    "symbol_mode",
    "theme_auto_detect",
    "include_gitignored_in_mentions",
    "show_cwd_in_input_border",
    "startup_tips_remaining",
];

/// Side effects `apply_response` asks the app to perform (it can't send
/// RPCs or touch the clipboard itself).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum ResponseEffect {
    #[default]
    None,
    /// Re-pull `get_state` (model/thinking/session changed).
    RefreshState,
    /// Copy this text to the clipboard.
    CopyToClipboard(String),
}

impl DialogState {
    /// The request id this dialog answers (extension dialogs only).
    pub fn id(&self) -> &str {
        match self {
            Self::Select { id, .. }
            | Self::Confirm { id, .. }
            | Self::Input { id, .. }
            | Self::Editor { id, .. } => id,
            Self::Plugin { id, .. } => id,
            Self::Local { .. } => "",
        }
    }

    /// True for locally-opened pickers (no `extension_ui_response`).
    pub fn is_local(&self) -> bool {
        matches!(self, Self::Local { .. })
    }
}

/// Compact one-line rendering of a `data` payload for system lines:
/// `k=v` pairs for scalars, JSON for the rest.
fn compact_json(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(k, val)| match val {
                serde_json::Value::String(s) => format!("{k}={s}"),
                serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {
                    format!("{k}={val}")
                }
                _ => format!("{k}={val}"),
            })
            .collect::<Vec<_>>()
            .join(" "),
        other => other.to_string(),
    }
}

/// One row in the subagent tray (RECON §12.2).
#[derive(Clone, Debug)]
pub struct TrayEntry {
    /// Which tab this entry lists under.
    pub kind: TrayKind,
    /// Display title (prompt/description/command from tool args).
    pub title: String,
    /// Spawning tool name (`task`, `bash`, …).
    pub tool: String,
    /// Model id at spawn time (status.model snapshot).
    pub model: String,
    /// Stable index into the 10-color subagent palette.
    pub color_idx: usize,
    /// Lifecycle status.
    pub status: TrayStatus,
    /// Nested tool executions observed while this entry ran.
    pub tools: u32,
    /// Recent nested tools `(name, target)` (≤6, newest last) —
    /// preview panel + subagent card activity feed.
    pub recent_tools: Vec<(String, String)>,
    /// App tick at `tool_execution_start`.
    pub start_tick: u64,
    /// App tick at `tool_execution_end` (None while running).
    pub end_tick: Option<u64>,
    /// Index into `messages` of the tool card (for `view`).
    pub msg_idx: usize,
    /// Devin `subagent/mode`: foregrounded entries stream their nested
    /// tool cards into the main scrollback; backgrounded ones hide them
    /// until the entry finishes. Shells default to background.
    pub foregrounded: bool,
    /// Owning `tool_call_id` — one dispatch call may expand into several
    /// per-agent rows that all close together on `tool_execution_end`.
    pub call_id: String,
    /// `Some(correlationId|taskIndex)` for per-agent rows synced from a
    /// teammate `details.progress` snapshot; `None` on the call-level row.
    pub agent_key: Option<String>,
    /// Agent's latest message tail (progress `lastMessage`) — the
    /// per-agent output shown in the tray preview.
    pub last_message: String,
    /// `/teammate-send` target (`correlationId`) when the row is backed
    /// by a teammate progress snapshot — set on call-level rows too.
    pub steer_target: Option<String>,
    /// Rolling output-log tail (progress `outputTail`) — a short window of
    /// the agent's recent output, rendered in the tray preview.
    pub output_tail: Vec<String>,
}

/// Tray tab an entry belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayKind {
    Subagent,
    Shell,
}

/// Lifecycle status of a tray entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayStatus {
    Running,
    Done,
    Failed,
    Cancelled,
}

/// The four tray tabs (RECON §12.2 + Todos — cockpit TodoOverlay parity).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TrayTab {
    #[default]
    Subagents,
    Cloud,
    Shells,
    Todos,
}

impl TrayTab {
    pub fn next(self) -> Self {
        match self {
            Self::Subagents => Self::Cloud,
            Self::Cloud => Self::Shells,
            Self::Shells => Self::Todos,
            Self::Todos => Self::Subagents,
        }
    }

    pub fn prev(self) -> Self {
        match self {
            Self::Subagents => Self::Todos,
            Self::Cloud => Self::Subagents,
            Self::Shells => Self::Cloud,
            Self::Todos => Self::Shells,
        }
    }

    pub fn label(self, shells: usize, todos: usize) -> String {
        match self {
            Self::Subagents => "Subagents".to_string(),
            Self::Cloud => "Cloud agents".to_string(),
            Self::Shells => format!("Shells ({shells})"),
            Self::Todos => format!("Todos ({todos})"),
        }
    }
}

/// Subagent/shell tray panel state (RECON §12.2 `TrayContent`).
#[derive(Clone, Debug, Default)]
pub struct TrayState {
    /// Panel visible (F2 toggles).
    pub open: bool,
    /// Active tab.
    pub tab: TrayTab,
    /// Cursor row within `visible()`.
    pub cursor: usize,
    /// All tracked entries (oldest → newest).
    pub entries: Vec<TrayEntry>,
}

impl TrayState {
    /// Entry indexes visible under the active tab (the Todos tab is
    /// backed by `state.todos`, not entries — it yields no indexes).
    pub fn visible(&self) -> Vec<usize> {
        self.entries
            .iter()
            .enumerate()
            .filter(|(_, e)| match self.tab {
                TrayTab::Subagents => e.kind == TrayKind::Subagent,
                TrayTab::Cloud => false,
                TrayTab::Shells => e.kind == TrayKind::Shell,
                TrayTab::Todos => false,
            })
            .map(|(i, _)| i)
            .collect()
    }

    /// Rows under the active tab — `todos` is `state.todos.len()`.
    pub fn rows(&self, todos: usize) -> usize {
        match self.tab {
            TrayTab::Todos => todos,
            _ => self.visible().len(),
        }
    }

    /// The selected entry index (into `entries`). None on the Todos
    /// tab — todo rows have no `TrayEntry`, so entry actions (view /
    /// kill / foreground) are no-ops there.
    pub fn selected(&self) -> Option<usize> {
        if self.tab == TrayTab::Todos {
            return None;
        }
        self.visible().get(self.cursor).copied()
    }

    pub fn move_up(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn move_down(&mut self, rows: usize) {
        if rows > 0 {
            self.cursor = (self.cursor + 1).min(rows - 1);
        }
    }

    /// Switch tab; cursor resets to the first row.
    pub fn set_tab(&mut self, tab: TrayTab) {
        self.tab = tab;
        self.cursor = 0;
    }

    /// Most recent still-running entry index. Nested top-level tools
    /// belong on the call-level row — per-agent rows (`agent_key`) are
    /// display-only and never own nested cards.
    fn last_running(&self) -> Option<usize> {
        self.entries
            .iter()
            .rposition(|e| e.status == TrayStatus::Running && e.agent_key.is_none())
            .or_else(|| {
                self.entries
                    .iter()
                    .rposition(|e| e.status == TrayStatus::Running)
            })
    }

    /// Title of the newest still-running subagent row — the status-line
    /// cue for delegated work (`[~] agent-name`).
    pub fn running_subagent(&self) -> Option<&str> {
        self.entries
            .iter()
            .rev()
            .find(|e| e.kind == TrayKind::Subagent && e.status == TrayStatus::Running)
            .map(|e| e.title.as_str())
    }

    /// `(running background shells, of which running ssh)` — the
    /// status-line `bg`/`ssh` indicators. An ssh session is a shell
    /// entry whose title (command) mentions `ssh`.
    pub fn running_shells(&self) -> (usize, usize) {
        let mut shells = 0;
        let mut ssh = 0;
        for e in &self.entries {
            if e.kind != TrayKind::Shell || e.status != TrayStatus::Running {
                continue;
            }
            shells += 1;
            if e.title.to_ascii_lowercase().contains("ssh") {
                ssh += 1;
            }
        }
        (shells, ssh)
    }
}

/// Classify a tool call as a tray entry: `bash` with `background:true`
/// is a shell; `task`/`agent`/`subagent`/`teammate`-named tools are
/// subagents. Everything else is a normal tool.
pub fn tray_kind(tool_name: &str, args: &serde_json::Value) -> Option<TrayKind> {
    let n = tool_name.to_ascii_lowercase();
    if n == "bash" || n == "shell" {
        if args.get("background").and_then(|v| v.as_bool()) == Some(true) {
            return Some(TrayKind::Shell);
        }
        return None;
    }
    if n == "task"
        || n == "agent"
        || n == "subagent"
        || n == "teammate"
        || n.contains("subagent")
        || n.ends_with("_agent")
        || n.ends_with("_task")
    {
        return Some(TrayKind::Subagent);
    }
    None
}

/// Display title for a tray entry: `description`/`prompt`/`command`/
/// `name` arg, else the tool name. First line, truncated to 48 chars.
fn tray_title(tool_name: &str, args: &serde_json::Value) -> String {
    // teammate dispatches carry `tasks: [{name?, prompt, …}]` — the
    // call-level row is the dispatch itself.
    if tool_name.eq_ignore_ascii_case("teammate") {
        if let Some(tasks) = args.get("tasks").and_then(|v| v.as_array()) {
            if tasks.len() > 1 {
                return format!("teammate · {} agents", tasks.len());
            }
            if let Some(t) = tasks.first() {
                for key in ["name", "prompt", "description"] {
                    if let Some(s) = t.get(key).and_then(|v| v.as_str()) {
                        let first = s.lines().next().unwrap_or("").trim();
                        if !first.is_empty() {
                            return first.chars().take(48).collect();
                        }
                    }
                }
            }
        }
    }
    for key in ["description", "prompt", "command", "name", "task"] {
        if let Some(s) = args.get(key).and_then(|v| v.as_str()) {
            let first = s.lines().next().unwrap_or("").trim();
            if !first.is_empty() {
                return first.chars().take(48).collect();
            }
        }
    }
    tool_name.to_string()
}

/// What the completion popup is completing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CompletionKind {
    /// `/cmd` — slash commands.
    Command,
    /// `@path` — file mentions.
    File,
}

/// One completion row: `name` is what accept inserts, `display` is
/// the rendered label (may include usage args), `desc` the right column.
#[derive(Clone, Debug)]
pub struct CompletionItem {
    pub name: String,
    pub display: String,
    pub desc: String,
}

/// `/`/`@` completion popup state (native pi TUI autocomplete;
/// Devin `completion` keymap context: next/prev/accept/close).
#[derive(Clone, Debug, Default)]
pub struct CompletionState {
    /// Filtered items.
    pub items: Vec<CompletionItem>,
    /// Highlighted row.
    pub cursor: usize,
    /// What is being completed.
    pub kind: CompletionKind,
    /// Byte index where the completed token starts (the `/` or `@`).
    pub token_start: usize,
}

impl Default for CompletionKind {
    fn default() -> Self {
        CompletionKind::Command
    }
}

impl CompletionState {
    pub fn next(&mut self) {
        if !self.items.is_empty() {
            self.cursor = (self.cursor + 1) % self.items.len();
        }
    }

    pub fn prev(&mut self) {
        if !self.items.is_empty() {
            self.cursor = self.cursor.checked_sub(1).unwrap_or(self.items.len() - 1);
        }
    }
}

/// A pasted image awaiting the next prompt (Ctrl+V).
#[derive(Clone, Debug)]
pub struct Attachment {
    /// Base64-encoded PNG.
    pub data: String,
    /// Always `image/png` for clipboard pastes.
    pub mime: String,
    /// Short label for the input hint (`image 1`).
    pub label: String,
}

/// A message sitting in pi's send queue (`queue_update` event).
/// `steering` entries inject into the running turn; `follow_up`
/// entries wait for it to end.
#[derive(Clone, Debug, PartialEq)]
pub struct QueuedMessage {
    pub text: String,
    pub steering: bool,
}

impl From<String> for QueuedMessage {
    fn from(text: String) -> Self {
        Self {
            text,
            steering: false,
        }
    }
}

impl From<&str> for QueuedMessage {
    fn from(text: &str) -> Self {
        Self::from(text.to_string())
    }
}

/// Normalized todo status (cockpit `mapStatus` equivalents).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TodoStatus {
    Pending,
    InProgress,
    Blocked,
    Completed,
}

/// One item of the persistent todo snapshot stored in the session's
/// `todo-state` custom entry — the same durable source cockpit's
/// `TodoStore` renders.
#[derive(Clone, Debug, PartialEq)]
pub struct TodoItem {
    /// Task id (`task-1`, `5`, …); used for ordering only.
    pub id: String,
    /// One-line subject; control chars stripped at ingest.
    pub subject: String,
    /// Normalized lifecycle status.
    pub status: TodoStatus,
}

/// Single-line safe text: drops ASCII control chars (incl. `\n`,
/// `\r`, ESC) so untrusted session content cannot inject terminal
/// escapes or break a rendered row.
fn clean_line(s: &str) -> String {
    s.chars().filter(|c| !c.is_control()).collect()
}

/// Root application state.
#[derive(Default)]
pub struct AppState {
    pub messages: Vec<Message>,
    pub input: InputState,
    pub status: StatusState,
    /// True while the agent is streaming a response.
    pub streaming: bool,
    /// True between sending `abort` and the run's terminal event —
    /// the working indicator reads this to show "Interrupting" while
    /// pi is still tearing the turn down.
    pub aborting: bool,
    /// Instant the current run started — drives the spinner's elapsed
    /// seconds readout. Cleared on the run's terminal event.
    pub run_started: Option<Instant>,
    /// How Enter dispatches input while streaming: steer immediately or
    /// enqueue it as a follow-up. `None` is only possible on `Default`;
    /// `AppState::new` installs pi's follow-up default.
    pub steering_mode: Option<StreamingBehavior>,
    /// Message-list scroll offset in cells (0 = top).
    pub scroll: u32,
    /// Follow the tail when new content arrives.
    pub follow_tail: bool,
    /// Active extension-UI dialog (select/confirm/input/editor).
    pub dialog: Option<DialogState>,
    /// Queued interactive UI requests behind the active dialog.
    pub pending_ui: VecDeque<RpcExtensionUIRequest>,
    /// The extension-UI request the active dialog is answering —
    /// re-queued on question deferral (Alt+Left/Right).
    pub active_req: Option<RpcExtensionUIRequest>,
    /// Ring position of the active question (0-based) for the
    /// `[q i+1/N]` indicator; ring size = 1 + pending_ui.len().
    pub q_pos: usize,
    /// Completed dialog responses awaiting `respond_ui` on the wire.
    pub dialog_result: Option<RpcExtensionUIResponse>,
    /// Transient `notify` toasts.
    pub toasts: Vec<Toast>,
    /// `setWidget` lines, keyed by widget key (insertion order kept).
    pub widgets: Vec<(String, Vec<String>)>,
    /// Pending terminal title (`setTitle`) — emitted as OSC on next frame.
    pub term_title: Option<String>,
    /// Pending desktop notification — emitted as OSC 9 on next frame
    /// (agent_end / settle).
    pub term_notify: Option<String>,
    /// Permission mode (Shift+Tab cycles).
    pub permission: PermissionMode,
    /// Glyph table (unicode/ASCII).
    pub glyphs: GlyphMode,
    /// `None` follows terminal theme detection; `Some` pins the current kind.
    pub theme_override: Option<ThemeKind>,
    /// Theme to restore if the `/theme` picker is Esc'd out of (live
    /// preview baseline); `None` while no preview is active.
    pub theme_restore: Option<ThemeKind>,
    /// App tick counter (33ms) — drives spinner/toasts.
    pub tick: u64,
    /// Full message-list rebuild requested (Ctrl+L clear, etc).
    pub needs_rebuild: bool,
    /// Set when the user asked to quit.
    pub quit: bool,
    /// Dirty flag: DOM needs a rebuild/patch before next paint.
    pub dom_dirty: bool,
    /// Cached `get_available_models` result (model picker + `/model <id>`
    /// provider lookup).
    pub models: Vec<Model>,
    /// Cached `get_available_thinking_levels` result.
    pub thinking_levels: Vec<ThinkingLevel>,
    /// Current-session entry ids and display labels for resume/tree/fork
    /// pickers. RPC exposes fork points, not a session-file list.
    pub session_points: Vec<(String, String)>,
    /// `/settings` boolean toggles (key → on).
    pub settings: std::collections::HashMap<String, bool>,
    /// pi-reported slash commands `(name, "desc (source)", source)`
    /// merged into the `/` completion list; filled by `get_commands`.
    /// `source` is pi's raw `"extension" | "prompt" | "skill"` tag —
    /// extension commands must dispatch through `prompt`.
    pub pi_commands: Vec<(String, String, String)>,
    /// Suppress `get_commands` system lines for the background fetch
    /// (startup + completion refresh); `/help` prints them instead.
    pub commands_quiet: bool,
    /// Active `/`/`@` completion popup (None when closed).
    pub completion: Option<CompletionState>,
    /// Pasted images attached to the next prompt (Ctrl+V).
    pub attachments: Vec<Attachment>,
    /// Selected attachment index (attachment_selection context).
    pub attachment_sel: Option<usize>,
    /// Queued messages while streaming (`queue_update` event).
    pub queued: Vec<QueuedMessage>,
    /// Persistent todo snapshot hydrated from the session's newest
    /// `todo-state` custom entry (cockpit `TodoStore` parity).
    pub todos: Vec<TodoItem>,
    /// Lazily-built file index for `@` completion (cwd-relative paths).
    /// `None` = not built yet; `Some` may be empty.
    pub file_index: Option<Vec<String>>,
    /// Subagent/shell tray panel (F2).
    pub tray: TrayState,
    /// Rotating input-hint tip index (RECON §9 tips).
    pub tip_idx: usize,
    /// Startup banner (`WelcomeBox`) still showing; hidden after the
    /// first submitted prompt.
    pub banner_visible: bool,
    /// DOM node id of the banner element (owned by message_list::sync).
    pub banner_node: Option<blitz_dom::NodeId>,
    /// Mouse drag selection — anchor/head in screen cells. Painted
    /// post-pass with `INVERSE`; `sel_text` holds the extracted copy.
    pub sel_anchor: Option<(u16, u16)>,
    /// Drag end point (None until the pointer moves).
    pub sel_head: Option<(u16, u16)>,
    /// Text under the selection, re-extracted on every painted frame.
    pub sel_text: String,
    /// Scrollback search (Ctrl+S) — modal query + match list.
    pub search: Option<SearchState>,
    /// Thinking-trace overlay (Alt+T): full-viewport scroll of every
    /// `MsgKind::Thinking` message (Devin `alt_screen` action).
    pub trace_open: bool,
    /// Scroll offset (cells) of the trace view.
    pub trace_scroll: u32,
    /// Signature of the rendered trace content (thinking count + total
    /// text len) — gates rebuilds; streamed appends bump the len.
    pub trace_sig: u64,
    /// Scrollbar metrics signature of the last rendered frame
    /// (content_h, view_h, scroll) — gates thumb style writes.
    pub scrollbar_sig: (u32, u32, u32),
}

/// Scrollback search state (Ctrl+S): query, matching message indexes,
/// and the cursor into `matches`.
#[derive(Clone, Debug, Default)]
pub struct SearchState {
    pub query: String,
    /// Indexes into `state.messages` that contain the query
    /// (case-insensitive substring), oldest first.
    pub matches: Vec<usize>,
    /// Cursor into `matches`.
    pub cursor: usize,
}

impl SearchState {
    /// Recompute `matches` for `query` against `messages` and mark the
    /// hit/current bubbles. Returns the current match index (into
    /// `messages`) if any.
    pub fn refresh(&mut self, messages: &mut [Message]) -> Option<usize> {
        let q = self.query.to_lowercase();
        self.matches = if q.is_empty() {
            Vec::new()
        } else {
            messages
                .iter()
                .enumerate()
                .filter(|(_, m)| {
                    m.text.to_lowercase().contains(&q)
                        || m.tool_output
                            .as_deref()
                            .is_some_and(|o| o.to_lowercase().contains(&q))
                })
                .map(|(i, _)| i)
                .collect()
        };
        // Cursor lands on the last match (nearest the tail the user is
        // usually reading); step() walks backwards/forwards from there.
        self.cursor = self.matches.len().saturating_sub(1);
        let current = self.matches.get(self.cursor).copied();
        for (i, m) in messages.iter_mut().enumerate() {
            m.search_mark = if Some(i) == current {
                SearchMark::Current
            } else if self.matches.contains(&i) {
                SearchMark::Hit
            } else {
                SearchMark::None
            };
        }
        current
    }

    /// Move the match cursor by `delta` (wrapping) and re-mark.
    pub fn step(&mut self, messages: &mut [Message], delta: i64) -> Option<usize> {
        if self.matches.is_empty() {
            return None;
        }
        let n = self.matches.len() as i64;
        self.cursor = ((self.cursor as i64 + delta).rem_euclid(n)) as usize;
        self.refresh_cursor_marks(messages);
        self.matches.get(self.cursor).copied()
    }

    fn refresh_cursor_marks(&mut self, messages: &mut [Message]) {
        let current = self.matches.get(self.cursor).copied();
        for (i, m) in messages.iter_mut().enumerate() {
            m.search_mark = if Some(i) == current {
                SearchMark::Current
            } else if self.matches.contains(&i) {
                SearchMark::Hit
            } else {
                SearchMark::None
            };
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        AppState {
            follow_tail: true,
            dom_dirty: true,
            glyphs: GlyphMode::detect(),
            steering_mode: Some(StreamingBehavior::FollowUp),
            status: StatusState {
                mode: "send:follow-up".to_string(),
                cwd: display_cwd(),
                git_branch: detect_git_branch(),
                ..StatusState::default()
            },
            banner_visible: true,
            settings: SETTINGS_KEYS
                .iter()
                .map(|k| {
                    // File mentions remain gitignore-aware by default.
                    (k.to_string(), *k != "include_gitignored_in_mentions")
                })
                .collect(),
            ..Default::default()
        }
    }

    /// Concatenated thinking text for the trace overlay.
    pub fn thinking_trace(&self) -> String {
        self.messages
            .iter()
            .filter(|m| m.kind == MsgKind::Thinking)
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    /// Signature for the trace content: message count + total len
    /// (streamed appends only grow the last thinking message).
    pub fn trace_signature(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut s = std::collections::hash_map::DefaultHasher::new();
        for m in &self.messages {
            if m.kind == MsgKind::Thinking {
                m.text.len().hash(&mut s);
            }
        }
        s.finish()
    }

    /// `show_tips` setting (drives the rotating input hint).
    pub fn show_tips(&self) -> bool {
        self.settings.get("show_tips").copied().unwrap_or(true)
    }

    /// Advance the tick: spinner frames + toast lifetimes + tip
    /// rotation (~10s per tip while the input is empty).
    /// Returns `true` when a repaint is needed.
    pub fn tick_frame(&mut self) -> bool {
        self.tick += 1;
        let mut dirty = self.streaming;
        if self.input.text.is_empty() && self.show_tips() && self.tick % 300 == 0 {
            self.tip_idx = (self.tip_idx + 1) % crate::components::input_box::TIPS.len();
            dirty = true;
        }
        if !self.toasts.is_empty() {
            dirty = true;
            for t in &mut self.toasts {
                t.ticks_left = t.ticks_left.saturating_sub(1);
            }
            self.toasts.retain(|t| t.ticks_left > 0);
        }
        // Re-read .git/HEAD every ~5s — branch switches mid-session show up
        // without a get_state round-trip.
        if self.tick.is_multiple_of(150) {
            let branch = detect_git_branch();
            if branch != self.status.git_branch {
                self.status.git_branch = branch;
                dirty = true;
            }
        }
        dirty
    }

    /// Drop the drag selection and its extracted text.
    pub fn clear_selection(&mut self) {
        self.sel_anchor = None;
        self.sel_head = None;
        self.sel_text.clear();
    }

    /// Push a message and mark the DOM dirty.
    pub fn push(&mut self, msg: Message) {
        self.messages.push(msg);
        self.dom_dirty = true;
    }

    pub fn push_user(&mut self, text: impl Into<String>) {
        // First real prompt dismisses the startup banner.
        self.banner_visible = false;
        self.push(Message::new(MsgKind::User, text));
    }

    pub fn push_system(&mut self, text: impl Into<String>) {
        self.push(Message::new(MsgKind::System, text));
    }

    /// Append text to the last message of `kind`, or start a new one.
    /// Returns the index of the message that received the text.
    fn append_to_last(&mut self, kind: MsgKind, delta: &str) -> usize {
        match self.messages.last_mut() {
            Some(m) if m.kind == kind && !m.sealed => {
                m.text.push_str(delta);
                self.messages.len() - 1
            }
            _ => {
                self.messages.push(Message::new(kind, delta));
                self.messages.len() - 1
            }
        }
    }

    /// Reduce one `RpcEvent` into state. Returns `true` when the DOM needs
    /// updating.
    pub fn apply_event(&mut self, event: &RpcEvent) -> bool {
        match event {
            RpcEvent::Agent(e) => self.apply_agent(e),
            RpcEvent::ExtensionUiRequest(req) => {
                self.open_ui(req);
                true
            }
            RpcEvent::StderrLine(line) => {
                // Surface pi stderr as a system line only when it looks like
                // an error (avoid noise).
                let l = line.to_lowercase();
                if l.contains("error") || l.contains("panic") || l.contains("fatal") {
                    self.push_system(format!("pi: {line}"));
                    true
                } else {
                    false
                }
            }
            RpcEvent::Other(value) => {
                // `extension_error` carries a failed extension command/hook
                // (e.g. a headless `/api-manager` write). Surface it instead
                // of silently dropping it.
                if value.get("type").and_then(|t| t.as_str()) == Some("extension_error") {
                    let detail = value
                        .get("error")
                        .and_then(|e| e.as_str())
                        .unwrap_or("unknown extension error");
                    let event = value.get("event").and_then(|e| e.as_str()).unwrap_or("");
                    self.push_system(if event.is_empty() {
                        format!("extension error: {detail}")
                    } else {
                        format!("extension error ({event}): {detail}")
                    });
                    true
                } else {
                    false
                }
            }
            RpcEvent::Response(_) => false,
        }
    }

    /// Shared end-of-run reduction for `agent_end` / `agent_settled`:
    /// stop the spinner, seal the live bubble, report an abort.
    fn finish_run(&mut self) {
        self.streaming = false;
        self.run_started = None;
        // An aborted run ends without `turn_end` — seal the last
        // assistant/thinking bubble here too or it stays live.
        if let Some(m) = self.messages.last_mut() {
            if matches!(m.kind, MsgKind::Assistant | MsgKind::Thinking) && !m.sealed {
                m.sealed = true;
                if m.kind == MsgKind::Thinking {
                    m.dirty = true;
                    self.dom_dirty = true;
                }
            }
        }
        if self.aborting {
            self.aborting = false;
            self.push_system("interrupted");
        }
        self.status.transient.clear();
    }

    fn apply_agent(&mut self, e: &AgentEvent) -> bool {
        match e {
            AgentEvent::AgentStart => {
                self.streaming = true;
                self.aborting = false;
                self.run_started = Some(Instant::now());
                self.status.transient.clear();
                true
            }
            AgentEvent::MessageUpdate { usage, .. } => {
                if let Some(u) = usage {
                    self.status.input_tokens = u.input as u64;
                    self.status.output_tokens = u.output as u64;
                    self.status.context_tokens = u.total_tokens as u64;
                }
                if let Some(d) = text_delta(e) {
                    self.append_to_last(MsgKind::Assistant, d);
                    self.dom_dirty = true;
                } else if let Some(d) = thinking_delta(e) {
                    self.append_to_last(MsgKind::Thinking, d);
                    self.dom_dirty = true;
                } else {
                    // Other assistant sub-events (toolcall_*, text_start/end)
                    // don't change visible state.
                    if let AgentEvent::MessageUpdate {
                        assistant_message_event:
                            AssistantMessageEvent::Error { reason, error },
                        ..
                    } = &e
                    {
                        // `reason:"aborted"` is the user pressing Esc — the
                        // abort path already prints "interrupted".
                        if reason != "aborted" {
                            let detail = assistant_error_message(error)
                                .unwrap_or_else(|| reason.clone());
                            self.push(Message::new(
                                MsgKind::Error,
                                format!("assistant error: {detail}"),
                            ));
                        }
                    }
                }
                true
            }
            AgentEvent::ToolExecutionStart {
                tool_call_id,
                tool_name,
                args,
                ..
            } => {
                // Tray: a tray tool opens a new entry; any other tool
                // started while one runs counts as a nested tool.
                let mut tray_idx = None;
                let mut nested_under = None;
                match tray_kind(tool_name, args) {
                    Some(kind) => {
                        tray_idx = Some(self.tray.entries.len());
                        // Devin: `background:true` spawns start hidden;
                        // interactive subagents stream in the foreground.
                        let background = args
                            .get("background")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(kind == TrayKind::Shell);
                        self.tray.entries.push(TrayEntry {
                            kind,
                            title: tray_title(tool_name, args),
                            tool: tool_name.clone(),
                            model: self.status.model.clone(),
                            color_idx: tray_idx.unwrap_or(0) % 10,
                            status: TrayStatus::Running,
                            tools: 0,
                            recent_tools: Vec::new(),
                            start_tick: self.tick,
                            end_tick: None,
                            msg_idx: self.messages.len(),
                            foregrounded: !background,
                            call_id: tool_call_id.clone(),
                            agent_key: None,
                            steer_target: None,
                            last_message: String::new(),
                            output_tail: Vec::new(),
                        });
                    }
                    None => {
                        if let Some(i) = self.tray.last_running() {
                            nested_under = Some(i);
                            let e = &mut self.tray.entries[i];
                            e.tools += 1;
                            e.recent_tools.push((
                                tool_name.clone(),
                                crate::components::tool_card::tool_target(args),
                            ));
                            if e.recent_tools.len() > 6 {
                                e.recent_tools.remove(0);
                            }
                            // Refresh the parent card's activity feed.
                            if let Some(pm) = self.messages.get_mut(e.msg_idx) {
                                pm.dirty = true;
                            }
                        }
                    }
                }
                let mut m = Message::new(MsgKind::Tool, summarize_args(args));
                m.tool_name = Some(tool_name.clone());
                m.tool_call_id = Some(tool_call_id.clone());
                m.tool_status = Some('●');
                m.tool_args = Some(args.clone());
                // Early lang guess (args + tool-name conventions) so
                // streamed partial output highlights before `end`.
                m.tool_lang = crate::components::tool_card::detect_lang(
                    tool_name,
                    args,
                    &serde_json::Value::Null,
                );
                m.tray_entry = tray_idx;
                m.nested_under = nested_under;
                self.push(m);
                true
            }
            AgentEvent::ToolExecutionUpdate {
                tool_call_id,
                tool_name,
                partial_result,
                ..
            } => {
                // Partial result → live tail window in the card body.
                // Strict tool_call_id match — nested tools interleave,
                // so falling back to "latest tool card" mis-paints.
                // A `details.progress` snapshot (teammate) renders as
                // per-agent status lines, not the opaque content blob.
                let partial_out = agent_progress_text(partial_result)
                    .unwrap_or_else(|| full_text(partial_result));
                let msg_idx = match self.messages.iter().rposition(|m| {
                    m.kind == MsgKind::Tool && m.tool_call_id.as_deref() == Some(tool_call_id)
                }) {
                    Some(i) => {
                        let m = &mut self.messages[i];
                        m.tool_name = Some(tool_name.clone());
                        if !partial_out.is_empty() {
                            m.tool_output = Some(partial_out);
                        }
                        m.dirty = true;
                        i
                    }
                    None => {
                        // Update without a seen start (compaction/replay) —
                        // create the pending card like `end` does.
                        let mut m = Message::new(MsgKind::Tool, String::new());
                        m.tool_name = Some(tool_name.clone());
                        m.tool_call_id = Some(tool_call_id.clone());
                        m.tool_status = Some('●');
                        if !partial_out.is_empty() {
                            m.tool_output = Some(partial_out);
                        }
                        self.push(m);
                        self.messages.len() - 1
                    }
                };
                self.dom_dirty = true;
                self.sync_agent_rows(tool_call_id, msg_idx, partial_result);
                true
            }
            AgentEvent::ToolExecutionEnd {
                tool_call_id,
                tool_name,
                result,
                is_error,
            } => {
                // Tray: close every running row this call owns — the
                // call-level entry plus its per-agent rows.
                for e in &mut self.tray.entries {
                    let owned = if e.call_id.is_empty() {
                        e.status == TrayStatus::Running && e.tool == *tool_name
                    } else {
                        e.call_id == *tool_call_id
                    };
                    if !owned || e.status != TrayStatus::Running {
                        continue;
                    }
                    e.status = if *is_error {
                        TrayStatus::Failed
                    } else {
                        TrayStatus::Done
                    };
                    e.end_tick = Some(self.tick);
                    // Backgrounded entries reveal their nested cards on
                    // finish ("user will not see output until you finish").
                    if !e.foregrounded {
                        self.needs_rebuild = true;
                    }
                }
                let status = if *is_error { '✗' } else { '✓' };
                let output = full_text(result);
                let exit = extract_exit_code(result);
                // Match the card by tool_call_id (nested tools interleave).
                if let Some(m) = self.messages.iter_mut().rev().find(|m| {
                    m.kind == MsgKind::Tool && m.tool_call_id.as_deref() == Some(tool_call_id)
                }) {
                    m.tool_status = Some(status);
                    m.tool_name = Some(tool_name.clone());
                    m.tool_exit = exit;
                    if m.text.is_empty() {
                        m.text = summarize_args(result);
                    }
                    if !output.is_empty() {
                        m.tool_output = Some(output);
                    }
                    let args = m.tool_args.clone().unwrap_or(serde_json::Value::Null);
                    m.tool_lang =
                        crate::components::tool_card::detect_lang(tool_name, &args, result);
                    m.dirty = true;
                    self.dom_dirty = true;
                    return true;
                }
                let mut m = Message::new(MsgKind::Tool, summarize_args(result));
                m.tool_name = Some(tool_name.clone());
                m.tool_call_id = Some(tool_call_id.clone());
                m.tool_status = Some(status);
                m.tool_exit = exit;
                if !output.is_empty() {
                    m.tool_output = Some(output);
                }
                m.tool_lang = crate::components::tool_card::detect_lang(
                    tool_name,
                    &serde_json::Value::Null,
                    result,
                );
                self.push(m);
                true
            }
            AgentEvent::TurnEnd { .. } => {
                // Finalize the streaming bubble: seal it so the next turn's
                // deltas start a fresh bubble instead of appending.
                if let Some(m) = self.messages.last_mut() {
                    if matches!(m.kind, MsgKind::Assistant | MsgKind::Thinking) {
                        m.sealed = true;
                        // Thinking collapses to a preview once sealed.
                        if m.kind == MsgKind::Thinking {
                            m.dirty = true;
                            self.dom_dirty = true;
                        }
                    }
                }
                false
            }
            AgentEvent::MessageEnd { message } => {
                // If the final assistant message carries usage, update tokens.
                // Cost accumulates once per message (here, not on updates).
                if let AgentMessage::Assistant { usage, .. } = message {
                    self.status.input_tokens = usage.input as u64;
                    self.status.output_tokens = usage.output as u64;
                    self.status.context_tokens = usage.total_tokens as u64;
                    self.status.cost += usage.cost.total;
                }
                if let AgentMessage::Unknown(v) = message {
                    return self.apply_custom_message_end(v);
                }
                false
            }
            AgentEvent::AgentEnd {
                messages,
                will_retry,
            } => {
                self.term_notify = Some(if will_retry.unwrap_or(false) {
                    "pi: retrying…".into()
                } else if agent_end_failed(messages) {
                    "pi: agent failed".into()
                } else {
                    "pi: agent finished".into()
                });
                self.finish_run();
                true
            }
            AgentEvent::AgentSettled => {
                self.term_notify = Some("pi: agent finished".into());
                self.finish_run();
                true
            }
            AgentEvent::CompactionStart { reason } => {
                self.status.transient = format!("compacting ({reason})");
                true
            }
            AgentEvent::CompactionEnd { reason, extra } => {
                self.status.transient.clear();
                let summary = ["summary", "compactionSummary", "message"]
                    .iter()
                    .find_map(|key| extra.get(*key).and_then(serde_json::Value::as_str))
                    .unwrap_or(reason);
                self.push(Message::new(
                    MsgKind::Compaction,
                    format!("◆ Compacted context: {summary}"),
                ));
                true
            }
            AgentEvent::AutoRetryStart {
                attempt,
                max_attempts,
                error_message,
                ..
            } => {
                self.status.transient = format!("retry {attempt}/{max_attempts}: {error_message}");
                true
            }
            AgentEvent::AutoRetryEnd {
                success,
                final_error,
                ..
            } => {
                self.status.transient.clear();
                if !success {
                    let detail = final_error.as_deref().unwrap_or("unknown error");
                    self.push(Message::new(
                        MsgKind::Error,
                        format!("auto-retry exhausted: {detail}"),
                    ));
                }
                true
            }
            AgentEvent::ThinkingLevelChanged { level } => {
                self.status.thinking = format!("{level:?}").to_lowercase();
                true
            }
            AgentEvent::BashExecutionUpdate { delta, .. } => {
                // Stream into the card body (sliding tail window), not
                // the header text.
                match self.messages.last_mut() {
                    Some(m) if m.kind == MsgKind::Tool => {
                        m.tool_output
                            .get_or_insert_with(String::new)
                            .push_str(delta);
                        m.dirty = true;
                    }
                    _ => {
                        let mut m = Message::new(MsgKind::Tool, "");
                        m.tool_output = Some(delta.to_string());
                        m.tool_status = Some('●');
                        self.push(m);
                    }
                }
                self.dom_dirty = true;
                true
            }
            AgentEvent::QueueUpdate {
                steering,
                follow_up,
            } => {
                self.queued = steering
                    .iter()
                    .map(|text| QueuedMessage {
                        text: text.clone(),
                        steering: true,
                    })
                    .chain(follow_up.iter().map(|text| QueuedMessage {
                        text: text.clone(),
                        steering: false,
                    }))
                    .collect();
                true
            }
            _ => is_run_end(e),
        }
    }

    /// Reduce one `extension_ui_request`: interactive methods open a
    /// dialog (or queue behind the active one); notifications update
    /// toasts / status / widgets / title / editor text directly.
    fn open_ui(&mut self, req: &RpcExtensionUIRequest) {
        // Track which request the surface is answering (for deferral);
        // queued requests don't touch it until promoted.
        if self.dialog.is_none() && req.expects_response() {
            self.active_req = Some(req.clone());
            self.q_pos = self.q_pos.min(self.pending_ui.len());
        }
        match req {
            RpcExtensionUIRequest::Select {
                id, title, options, ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Select {
                        id: id.clone(),
                        sel: SelectState::new(title.clone(), options.clone()),
                    });
                }
            }
            RpcExtensionUIRequest::Confirm {
                id, title, message, ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Confirm {
                        id: id.clone(),
                        title: title.clone(),
                        message: message.clone(),
                    });
                }
            }
            RpcExtensionUIRequest::Input {
                id,
                title,
                placeholder,
                ..
            } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Input {
                        id: id.clone(),
                        title: title.clone(),
                        placeholder: placeholder.clone(),
                        input: InputState::default(),
                    });
                }
            }
            RpcExtensionUIRequest::Editor { id, title, prefill } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    let mut input = InputState::default();
                    if let Some(p) = prefill {
                        input.insert_str(p);
                    }
                    self.dialog = Some(DialogState::Editor {
                        id: id.clone(),
                        title: title.clone(),
                        input,
                    });
                }
            }
            RpcExtensionUIRequest::Notify {
                message,
                notify_type,
                ..
            } => {
                let text = match notify_type.as_deref() {
                    Some(t) if !t.is_empty() => format!("{t}: {message}"),
                    _ => message.clone(),
                };
                self.toasts.push(Toast {
                    text,
                    ticks_left: crate::components::dialog::TOAST_TICKS,
                });
            }
            RpcExtensionUIRequest::SetStatus {
                status_key,
                status_text,
                ..
            } => {
                let _ = status_key;
                self.status.transient = status_text.clone().unwrap_or_default();
            }
            RpcExtensionUIRequest::SetWidget {
                widget_key,
                widget_lines,
                ..
            } => match widget_lines {
                Some(lines) => {
                    if let Some(slot) = self.widgets.iter_mut().find(|(k, _)| k == widget_key) {
                        slot.1 = lines.clone();
                    } else {
                        self.widgets.push((widget_key.clone(), lines.clone()));
                    }
                }
                None => self.widgets.retain(|(k, _)| k != widget_key),
            },
            RpcExtensionUIRequest::SetTitle { title, .. } => {
                self.term_title = Some(title.clone());
            }
            RpcExtensionUIRequest::SetEditorText { text, .. } => {
                self.input.text = text.clone();
                self.input.cursor = text.len();
            }
            RpcExtensionUIRequest::Custom { id, driver, spec } => {
                if self.dialog.is_some() {
                    self.pending_ui.push_back(req.clone());
                } else {
                    self.dialog = Some(DialogState::Plugin {
                        id: id.clone(),
                        spec: spec.clone(),
                        driver: *driver,
                        frame: Vec::new(),
                        cursor: None,
                    });
                }
            }
            RpcExtensionUIRequest::OverlayFrame { id, frame, cursor } => {
                // Frames only apply to the surface they were opened under;
                // a stale id (overlay already closed) is dropped.
                if let Some(DialogState::Plugin {
                    id: active,
                    frame: slot,
                    cursor: cur,
                    ..
                }) = &mut self.dialog
                {
                    if active == id {
                        *slot = frame.clone();
                        *cur = *cursor;
                    }
                }
            }
            RpcExtensionUIRequest::OverlayClose { id } => {
                if let Some(d) = &self.dialog {
                    if d.id() == id {
                        match d {
                            // Agent-driven close of a client-driven overlay:
                            // unblock the pending request with a cancel.
                            DialogState::Plugin {
                                driver: OverlayDriver::Client,
                                id,
                                ..
                            } => {
                                let id = id.clone();
                                self.resolve_dialog(RpcExtensionUIResponse::Cancelled {
                                    id,
                                    cancelled: true,
                                });
                            }
                            // Plugin-driven close: free the surface, promote
                            // the queue, no response is owed.
                            DialogState::Plugin { .. } => {
                                self.dialog = None;
                                self.promote_pending_ui();
                            }
                            _ => {}
                        }
                    }
                }
            }
            RpcExtensionUIRequest::Unknown(v) => {
                self.push_system(format!(
                    "ui request: {} ({})",
                    v.get("method").and_then(|m| m.as_str()).unwrap_or("?"),
                    req.id()
                ));
            }
        }
        self.dom_dirty = true;
    }

    /// Resolve the active dialog with `resp` (queued for `respond_ui`),
    /// then promote the next queued interactive request if any.
    pub fn resolve_dialog(&mut self, resp: RpcExtensionUIResponse) {
        self.dialog = None;
        self.active_req = None;
        self.dialog_result = Some(resp);
        self.promote_pending_ui();
    }

    /// Defer the active question: re-queue its request and promote the
    /// next (`dir >= 0`) or previous (`dir < 0`) one in the ring —
    /// Devin `user_question` next/prev. No response is sent; the
    /// deferred question keeps its place in the ring order.
    /// Returns false when there is nothing to rotate to.
    pub fn defer_question(&mut self, dir: i64) -> bool {
        let Some(req) = self.active_req.take() else {
            return false;
        };
        if self.pending_ui.is_empty() {
            self.active_req = Some(req);
            return false;
        }
        if dir >= 0 {
            // Ring rotate left: [active, q0..qk-1] → [q0..qk-1, active];
            // promote pops q0.
            self.pending_ui.push_back(req);
        } else {
            // Ring rotate right: [active, q0..qk-1] → [qk-1, active,
            // q0..qk-2]; promote pops qk-1. Original order is preserved
            // — after answering, the queue continues in display order.
            self.pending_ui.push_front(req);
            if let Some(back) = self.pending_ui.pop_back() {
                self.pending_ui.push_front(back);
            }
        }
        let n = self.pending_ui.len() as i64; // ring size incl. next active
        self.q_pos = (self.q_pos as i64 + dir).rem_euclid(n) as usize;
        self.dialog = None;
        self.promote_pending_ui();
        true
    }

    /// `[q i+1/N]` indicator for the dialog chrome while questions are
    /// queued behind the active one.
    pub fn q_indicator(&self) -> Option<String> {
        if self.active_req.is_some() && !self.pending_ui.is_empty() {
            Some(format!(
                "[q {}/{}]",
                self.q_pos + 1,
                self.pending_ui.len() + 1
            ))
        } else {
            None
        }
    }

    /// Promote queued UI requests after the modal surface frees up: apply
    /// fire-and-forget requests inline, stop at the next surface-occupying
    /// one (interactive dialog or plugin overlay).
    fn promote_pending_ui(&mut self) {
        while let Some(next) = self.pending_ui.pop_front() {
            if next.occupies_surface() {
                self.open_ui(&next);
                break;
            }
            // Non-interactive requests queued behind a dialog still apply.
            self.open_ui(&next);
        }
        self.dom_dirty = true;
    }

    /// Cancel the active dialog (Esc) — extension dialogs respond
    /// `cancelled:true`; local pickers just close.
    pub fn cancel_dialog(&mut self) {
        match &self.dialog {
            Some(DialogState::Local { .. }) => {
                self.dialog = None;
                self.dom_dirty = true;
            }
            // Plugin-driven overlays owe no response; the dismissal is
            // reported to the plugin as an `extension_ui_event` by the app.
            Some(DialogState::Plugin {
                driver: OverlayDriver::Plugin,
                ..
            }) => {
                self.dialog = None;
                self.promote_pending_ui();
            }
            Some(d) => {
                let id = d.id().to_string();
                self.resolve_dialog(RpcExtensionUIResponse::Cancelled {
                    id,
                    cancelled: true,
                });
            }
            None => {}
        }
    }

    /// Rebuild `todos` and settled teammate rows from a `get_entries`
    /// response: the newest `custom` entry whose `customType` is
    /// `todo-state` holds the authoritative task map (the todo tool
    /// rewrites it whole on every mutation), and `custom_message` entries
    /// of type `teammate-complete` carry the settled agents' results.
    /// Returns whether anything changed. This path does NOT touch
    /// `session_points` — it is the background-hydration twin of the
    /// `/resume` `get_entries` arm.
    pub fn hydrate_todos(&mut self, resp: &RpcResponse) -> bool {
        let Some(entries) = resp
            .data
            .as_ref()
            .and_then(|d| d.get("entries"))
            .and_then(|v| v.as_array())
        else {
            return false;
        };
        let mut changed = self.hydrate_teammate_rows(entries);
        changed |= self.hydrate_todo_entries(entries);
        changed
    }

    fn hydrate_todo_entries(&mut self, entries: &[serde_json::Value]) -> bool {
        let data = entries
            .iter()
            .rfind(|e| {
                e.get("type").and_then(|v| v.as_str()) == Some("custom")
                    && e.get("customType").and_then(|v| v.as_str()) == Some("todo-state")
            })
            .map(|e| e.get("data").unwrap_or(e));
        let mut todos = Vec::new();
        if let Some(tasks) = data
            .and_then(|d| d.get("tasks"))
            .and_then(|v| v.as_object())
        {
            for (id, raw) in tasks {
                let status = match raw.get("status").and_then(|v| v.as_str()).unwrap_or("") {
                    "in_progress" | "in-progress" => TodoStatus::InProgress,
                    "completed" | "complete" => TodoStatus::Completed,
                    "blocked" => TodoStatus::Blocked,
                    "deleted" => continue,
                    _ => TodoStatus::Pending,
                };
                let subject = raw
                    .get("subject")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                todos.push(TodoItem {
                    id: id.clone(),
                    subject: clean_line(subject),
                    status,
                });
            }
        }
        if todos == self.todos {
            return false;
        }
        self.todos = todos;
        true
    }

    /// Rebuild settled teammate tray rows from `custom_message` /
    /// `teammate-complete` entries — attach or resume after the run shows
    /// the agents that finished and their outputs. Rows that are still
    /// `Running` belong to the live event stream and win; already-settled
    /// rows are refreshed so a steered agent's latest completion lands.
    fn hydrate_teammate_rows(&mut self, entries: &[serde_json::Value]) -> bool {
        let mut changed = false;
        for e in entries {
            if e.get("type").and_then(|v| v.as_str()) != Some("custom_message")
                || e.get("customType").and_then(|v| v.as_str()) != Some("teammate-complete")
            {
                continue;
            }
            let Some(results) = e.pointer("/details/results").and_then(|r| r.as_array()) else {
                continue;
            };
            for r in results {
                let Some(cid) = r.get("correlationId").and_then(|c| c.as_str()) else {
                    continue;
                };
                let status = match r.get("completionOutcome").and_then(|o| o.as_str()) {
                    Some("failed") => TrayStatus::Failed,
                    Some("terminated") => TrayStatus::Cancelled,
                    _ => TrayStatus::Done,
                };
                let output = r
                    .get("output")
                    .and_then(|o| o.as_str())
                    .map(str::to_string)
                    .or_else(|| {
                        r.get("structuredOutput")
                            .and_then(|s| serde_json::to_string_pretty(s).ok())
                    });
                let idx = self.tray.entries.iter().position(|x| {
                    (x.steer_target.as_deref() == Some(cid)
                        || x.agent_key.as_deref() == Some(cid))
                        && x.status != TrayStatus::Running
                });
                if let Some(i) = idx {
                    let entry = &mut self.tray.entries[i];
                    entry.status = status;
                    if let Some(out) = &output {
                        if let Some(last) =
                            out.lines().map(str::trim).rfind(|l| !l.is_empty())
                        {
                            entry.last_message = last.to_string();
                        }
                    }
                    changed = true;
                    continue;
                }
                let last_message = output
                    .as_deref()
                    .and_then(|out| out.lines().map(str::trim).rfind(|l| !l.is_empty()))
                    .unwrap_or("")
                    .to_string();
                self.tray.entries.push(TrayEntry {
                    kind: TrayKind::Subagent,
                    title: progress_row_title(r),
                    tool: "teammate".into(),
                    model: String::new(),
                    color_idx: self.tray.entries.len() % 10,
                    status,
                    tools: 0,
                    recent_tools: Vec::new(),
                    start_tick: self.tick,
                    end_tick: Some(self.tick),
                    // No backing card — hydrated rows are history.
                    msg_idx: usize::MAX,
                    foregrounded: false,
                    call_id: String::new(),
                    agent_key: Some(cid.to_string()),
                    last_message,
                    steer_target: Some(cid.to_string()),
                    output_tail: Vec::new(),
                });
                changed = true;
            }
            // Rows exist now — fold the completion's final progress
            // snapshot in for `outputTail`/status/lastMessage.
            changed |= self.apply_teammate_progress(e.pointer("/details/progress"));
        }
        changed
    }

    /// Reduce one command `RpcResponse` into state. Returns the side
    /// effect the app must perform (state refresh, clipboard write).
    /// Failure responses become system lines here too.
    pub fn apply_response(&mut self, resp: &RpcResponse) -> ResponseEffect {
        if !resp.success {
            if resp.command == "abort" {
                self.aborting = false;
            }
            self.push_system(format!(
                "{} failed: {}",
                resp.command,
                resp.error.as_deref().unwrap_or("unknown error")
            ));
            return ResponseEffect::None;
        }
        match resp.command.as_str() {
            "set_model" => {
                if let Some(m) = resp.model_data() {
                    self.status.model = m.id.clone();
                    self.status.context_window = m.context_window as u64;
                    self.push_system(format!("model → {}", m.id));
                }
                ResponseEffect::RefreshState
            }
            "cycle_model" => match resp.cycle_model_data() {
                Some((m, level)) => {
                    self.status.model = m.id.clone();
                    self.status.context_window = m.context_window as u64;
                    self.status.thinking = format!("{level:?}").to_lowercase();
                    self.push_system(format!("model → {}", m.id));
                    ResponseEffect::RefreshState
                }
                None => {
                    self.push_system("cycle_model: no other scoped model");
                    ResponseEffect::None
                }
            },
            "set_thinking_level" => ResponseEffect::RefreshState,
            "cycle_thinking_level" => match resp.cycle_thinking_level() {
                Some(l) => {
                    self.status.thinking = format!("{l:?}").to_lowercase();
                    ResponseEffect::RefreshState
                }
                None => ResponseEffect::None,
            },
            "get_available_models" => {
                if let Some(models) = resp.available_models() {
                    self.models = models;
                    self.open_local_select(LocalAction::SetModel);
                }
                ResponseEffect::None
            }
            "get_available_thinking_levels" => {
                if let Some(levels) = resp.available_thinking_levels() {
                    self.thinking_levels = levels;
                    self.open_local_select(LocalAction::SetThinking);
                }
                ResponseEffect::None
            }
            "get_entries" => {
                self.session_points = resp
                    .data
                    .as_ref()
                    .and_then(|d| d.get("entries"))
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| {
                        let id = entry.get("id")?.as_str()?.to_string();
                        let kind = entry
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("entry");
                        let preview = entry
                            .get("message")
                            .and_then(|m| m.get("content"))
                            .and_then(|c| c.as_str())
                            .or_else(|| entry.get("summary").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        let preview: String = preview.chars().take(72).collect();
                        let label = if preview.is_empty() {
                            format!("{kind} · {id}")
                        } else {
                            format!("{kind} · {preview} · {id}")
                        };
                        Some((id, label))
                    })
                    .collect();
                self.open_local_select(LocalAction::ResumeEntry);
                ResponseEffect::None
            }
            "get_fork_messages" => {
                self.session_points = resp
                    .data
                    .as_ref()
                    .and_then(|d| d.get("messages"))
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                    .filter_map(|message| {
                        let id = message.get("entryId")?.as_str()?.to_string();
                        let text = message.get("text").and_then(|v| v.as_str()).unwrap_or("");
                        let preview: String = text.chars().take(96).collect();
                        Some((id.clone(), format!("{preview} · {id}")))
                    })
                    .collect();
                self.open_local_select(LocalAction::ForkEntry);
                ResponseEffect::None
            }
            "get_tree" => {
                self.session_points.clear();
                if let Some(tree) = resp
                    .data
                    .as_ref()
                    .and_then(|d| d.get("tree"))
                    .and_then(|v| v.as_array())
                {
                    let mut stack: Vec<(&serde_json::Value, usize)> =
                        tree.iter().rev().map(|node| (node, 0)).collect();
                    while let Some((node, depth)) = stack.pop() {
                        let Some(entry) = node.get("entry") else {
                            continue;
                        };
                        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        let kind = entry
                            .get("type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("entry");
                        let text = node
                            .get("label")
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                entry
                                    .get("message")
                                    .and_then(|m| m.get("content"))
                                    .and_then(|v| v.as_str())
                            })
                            .or_else(|| entry.get("summary").and_then(|v| v.as_str()))
                            .unwrap_or(kind);
                        let preview: String = text.chars().take(72).collect();
                        self.session_points.push((
                            id.to_string(),
                            format!("{}{preview} · {id}", "  ".repeat(depth)),
                        ));
                        if let Some(children) = node.get("children").and_then(|v| v.as_array()) {
                            stack.extend(children.iter().rev().map(|child| (child, depth + 1)));
                        }
                    }
                }
                self.open_local_select(LocalAction::TreeEntry);
                ResponseEffect::None
            }
            "new_session" | "switch_session" | "fork" | "clone" => {
                if resp.cancelled() {
                    self.push_system(format!("{} cancelled", resp.command));
                    ResponseEffect::None
                } else {
                    self.clear_messages();
                    // Fresh session: zero the resource meters.
                    self.status.input_tokens = 0;
                    self.status.output_tokens = 0;
                    self.status.context_tokens = 0;
                    self.status.cost = 0.0;
                    self.push_system(format!("{}: fresh session", resp.command));
                    ResponseEffect::RefreshState
                }
            }
            "compact" => {
                self.push_system("session compacted");
                ResponseEffect::RefreshState
            }
            "get_session_stats" => {
                let line = resp
                    .data
                    .as_ref()
                    .map(|d| format!("session stats: {}", compact_json(d)))
                    .unwrap_or_else(|| "session stats: (none)".to_string());
                self.push_system(line);
                ResponseEffect::None
            }
            "export_html" => match resp.export_path() {
                Some(p) => {
                    self.push_system(format!("exported → {p}"));
                    ResponseEffect::None
                }
                None => ResponseEffect::None,
            },
            "set_session_name" => {
                self.push_system("session renamed");
                ResponseEffect::None
            }
            "get_last_assistant_text" => match resp.last_assistant_text() {
                Some(t) if !t.is_empty() => ResponseEffect::CopyToClipboard(t),
                _ => {
                    self.push_system("nothing to copy");
                    ResponseEffect::None
                }
            },
            "get_commands" => {
                if let Some(cmds) = resp.slash_commands() {
                    self.pi_commands = cmds
                        .iter()
                        .map(|c| {
                            let desc = c.description.as_deref().unwrap_or("");
                            (
                                c.name.clone(),
                                format!("{desc} ({})", c.source),
                                c.source.clone(),
                            )
                        })
                        .collect();
                    if self.commands_quiet {
                        self.commands_quiet = false;
                    } else {
                        let lines: Vec<String> = self
                            .pi_commands
                            .iter()
                            .map(|(name, desc, _)| format!("/{name} — {desc}"))
                            .collect();
                        for line in lines {
                            self.push_system(line);
                        }
                    }
                }
                ResponseEffect::None
            }
            _ => ResponseEffect::None,
        }
    }

    /// Open a local picker for `action` from the cached lists.
    pub fn open_local_select(&mut self, action: LocalAction) {
        let sel = match action {
            LocalAction::SetModel => {
                if self.models.is_empty() {
                    self.push_system("no models reported by pi");
                    return;
                }
                crate::components::select::model_picker(
                    "select model",
                    &self.models,
                    &self.status.model,
                    self.status.input_tokens,
                )
            }
            LocalAction::SetThinking => {
                if self.thinking_levels.is_empty() {
                    self.push_system("no thinking levels reported by pi");
                    return;
                }
                crate::components::select::thinking_picker("thinking level", &self.thinking_levels)
            }
            LocalAction::ToggleSetting => {
                let options = SETTINGS_KEYS
                    .iter()
                    .map(|k| {
                        let on = self.settings.get(*k).copied().unwrap_or(true);
                        let label = if *k == "startup_tips_remaining" {
                            "startup_tips_remaining (bool proxy)"
                        } else {
                            k
                        };
                        format!("{label}: {}", if on { "on" } else { "off" })
                    })
                    .collect();
                crate::components::select::SelectState::new("settings", options)
            }
            LocalAction::SetTheme => {
                // `/theme` normally opens via `open_theme_select` (which
                // knows the live kind); this arm is the fallback when a
                // caller reaches the generic path.
                let current = self.theme_override.unwrap_or_else(crate::theme::detect);
                self.theme_restore = Some(current);
                crate::components::select::theme_picker(current)
            }
            LocalAction::ResumeEntry | LocalAction::TreeEntry | LocalAction::ForkEntry => {
                if self.session_points.is_empty() {
                    self.push_system("no fork points reported by pi");
                    return;
                }
                let title = match action {
                    LocalAction::ResumeEntry => "resume: pick a fork point",
                    LocalAction::TreeEntry => "session tree: pick a fork point",
                    LocalAction::ForkEntry => "fork: pick a user message",
                    _ => unreachable!(),
                };
                crate::components::select::SelectState::new(
                    title,
                    self.session_points
                        .iter()
                        .map(|(_, label)| label.clone())
                        .collect(),
                )
            }
        };
        self.dialog = Some(DialogState::Local { sel, action });
        self.dom_dirty = true;
    }

    /// Open the `/theme` picker: rows are `auto` + every `ThemeKind`,
    /// cursor on the active theme, `theme_restore` armed for preview.
    pub fn open_theme_select(&mut self, current: ThemeKind) {
        let sel = crate::components::select::theme_picker(current);
        self.theme_restore = Some(current);
        self.dialog = Some(DialogState::Local {
            sel,
            action: LocalAction::SetTheme,
        });
        self.dom_dirty = true;
    }

    /// True when `name` (without the leading `/`) is a pi-reported
    /// command whose source is `extension`. pi's `steer`/`follow_up`
    /// reject extension commands — they must go through `prompt`,
    /// which executes them immediately.
    pub fn is_extension_command(&self, name: &str) -> bool {
        self.pi_commands
            .iter()
            .any(|(n, _, src)| n == name && src == "extension")
    }

    /// Full `/` completion candidates: built-ins + pi commands.
    /// `display` keeps the usage string (`/model [provider/id]`).
    pub fn command_list(&self) -> Vec<CompletionItem> {
        let mut v: Vec<CompletionItem> = crate::commands::BUILTIN_HELP
            .iter()
            .map(|(usage, desc)| {
                // "/model [provider/id]" → name "model"
                let name = usage[1..]
                    .split(char::is_whitespace)
                    .next()
                    .unwrap_or("")
                    .to_string();
                CompletionItem {
                    name,
                    display: usage.to_string(),
                    desc: desc.to_string(),
                }
            })
            .collect();
        for (name, desc, _source) in &self.pi_commands {
            if !v.iter().any(|i| i.name == *name) {
                v.push(CompletionItem {
                    name: name.clone(),
                    display: format!("/{name}"),
                    desc: desc.clone(),
                });
            }
        }
        v
    }

    /// Recompute the completion popup from the current input.
    /// `/word` (single token) → commands; `@tok` → file mentions.
    pub fn update_completion(&mut self) {
        self.input.ghost =
            if self.input.cursor == self.input.text.len() && !self.input.text.is_empty() {
                self.input.history.iter().rev().find_map(|entry| {
                    entry
                        .strip_prefix(&self.input.text)
                        .filter(|suffix| !suffix.is_empty())
                        .map(str::to_string)
                })
            } else {
                None
            };

        let upto = &self.input.text[..self.input.cursor];
        // `/cmd` — only when the slash is the first char and no
        // whitespace precedes the cursor.
        if upto.starts_with('/') && !upto[1..].contains(char::is_whitespace) {
            let prefix = &upto[1..];
            let mut scored: Vec<(i64, CompletionItem)> = self
                .command_list()
                .into_iter()
                .filter_map(|item| {
                    crate::fuzzy::score(prefix, &item.name).map(|score| (score, item))
                })
                .collect();
            scored.sort_by(|(a_score, a), (b_score, b)| {
                b_score.cmp(a_score).then_with(|| a.name.cmp(&b.name))
            });
            let items = scored.into_iter().map(|(_, item)| item).collect();
            self.set_completion(items, CompletionKind::Command, 0);
            return;
        }
        // `@file` — token after the last `@` before the cursor; the
        // char before `@` must be start/whitespace (not `a@b`).
        if let Some(at) = upto.rfind('@') {
            let before_ok = at == 0
                || upto[..at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_whitespace());
            let token = &upto[at + 1..];
            if before_ok && !token.contains(char::is_whitespace) {
                let items = self.file_matches(token);
                self.set_completion(items, CompletionKind::File, at);
                return;
            }
        }
        self.completion = None;
    }

    fn set_completion(
        &mut self,
        items: Vec<CompletionItem>,
        kind: CompletionKind,
        token_start: usize,
    ) {
        if items.is_empty() {
            self.completion = None;
            return;
        }
        let keep = self
            .completion
            .as_ref()
            .filter(|c| c.kind == kind && c.token_start == token_start)
            .map(|c| c.cursor)
            .unwrap_or(0);
        self.completion = Some(CompletionState {
            cursor: keep.min(items.len() - 1),
            items,
            kind,
            token_start,
        });
    }

    /// Fuzzy-ranked file-index matches for an `@` token, capped at 50.
    fn file_matches(&self, token: &str) -> Vec<CompletionItem> {
        let Some(index) = &self.file_index else {
            return Vec::new();
        };
        let mut scored: Vec<(i64, &String)> = index
            .iter()
            .filter_map(|path| crate::fuzzy::score(token, path).map(|score| (score, path)))
            .collect();
        scored.sort_by(|(a_score, a), (b_score, b)| b_score.cmp(a_score).then_with(|| a.cmp(b)));
        scored
            .into_iter()
            .take(50)
            .map(|(_, path)| CompletionItem {
                name: path.clone(),
                display: format!("@{path}"),
                desc: String::new(),
            })
            .collect()
    }

    /// Accept the highlighted completion: splice the item over the
    /// token and close the popup. Returns the accepted name.
    pub fn accept_completion(&mut self) -> Option<String> {
        let c = self.completion.take()?;
        let name = c.items.get(c.cursor)?.name.clone();
        let (prefix, suffix) = match c.kind {
            CompletionKind::Command => ("/", " "),
            CompletionKind::File => ("@", " "),
        };
        let mut text = String::with_capacity(name.len() + 8);
        text.push_str(&self.input.text[..c.token_start]);
        text.push_str(prefix);
        text.push_str(&name);
        text.push_str(suffix);
        let cursor = text.len();
        text.push_str(&self.input.text[self.input.cursor..]);
        self.input.text = text;
        self.input.cursor = cursor;
        self.input.history_idx = None;
        self.dom_dirty = true;
        Some(name)
    }

    /// Clear the message list (Ctrl+L).
    pub fn clear_messages(&mut self) {
        self.messages.clear();
        self.scroll = 0;
        self.follow_tail = true;
        self.needs_rebuild = true;
        self.dom_dirty = true;
    }

    /// Toggle `expanded` on the most recent collapsible message — a
    /// tool card with output or a sealed thinking bubble (Ctrl+O).
    /// Returns `true` when a card toggled.
    pub fn toggle_last_tool(&mut self) -> bool {
        if let Some(m) = self.messages.iter_mut().rev().find(|m| {
            (m.kind == MsgKind::Tool && m.tool_output.is_some())
                || (m.kind == MsgKind::Thinking && m.sealed)
        }) {
            m.expanded = !m.expanded;
            m.dirty = true;
            self.dom_dirty = true;
            true
        } else {
            false
        }
    }

    /// Devin `subagent/foreground|background`: toggle whether the
    /// selected tray entry's nested tool cards stream into the
    /// scrollback. Returns the new foregrounded state.
    pub fn toggle_tray_foreground(&mut self) -> Option<bool> {
        let i = self.tray.selected()?;
        let e = &mut self.tray.entries[i];
        e.foregrounded = !e.foregrounded;
        self.needs_rebuild = true;
        self.dom_dirty = true;
        Some(e.foregrounded)
    }

    /// Sync per-agent tray rows from a teammate `details.progress`
    /// snapshot carried by `tool_execution_update`. A single-task run
    /// folds its one snapshot into the call-level row; a multi-task
    /// dispatch gets one selectable row per agent (stable key:
    /// `correlationId`, else `taskIndex`).
    fn sync_agent_rows(&mut self, call_id: &str, msg_idx: usize, v: &serde_json::Value) {
        let Some(progress) = v
            .get("details")
            .and_then(|d| d.get("progress"))
            .and_then(|p| p.as_array())
        else {
            return;
        };
        if progress.is_empty() {
            return;
        }
        // Call-level row created at `tool_execution_start`; without it
        // there is nothing to attach rows to (replayed updates).
        let Some(parent) = self
            .tray
            .entries
            .iter()
            .position(|e| e.call_id == call_id && e.agent_key.is_none())
        else {
            return;
        };
        if progress.len() == 1 {
            apply_progress_row(&mut self.tray.entries[parent], &progress[0], self.tick);
            return;
        }
        for p in progress {
            let Some(key) = p
                .get("correlationId")
                .and_then(|x| x.as_str())
                .map(str::to_string)
                .or_else(|| p.get("taskIndex").map(|i| i.to_string()))
            else {
                continue;
            };
            let idx = self
                .tray
                .entries
                .iter()
                .position(|e| e.call_id == call_id && e.agent_key.as_deref() == Some(key.as_str()));
            let i = match idx {
                Some(i) => i,
                None => {
                    let color_idx = self.tray.entries.len() % 10;
                    let (tool, model) = {
                        let pe = &self.tray.entries[parent];
                        (pe.tool.clone(), pe.model.clone())
                    };
                    self.tray.entries.push(TrayEntry {
                        kind: TrayKind::Subagent,
                        title: progress_row_title(p),
                        tool,
                        model,
                        color_idx,
                        status: TrayStatus::Running,
                        tools: 0,
                        recent_tools: Vec::new(),
                        start_tick: self.tick,
                        end_tick: None,
                        msg_idx,
                        foregrounded: true,
                        call_id: call_id.to_string(),
                        agent_key: Some(key),
                        last_message: String::new(),
                        steer_target: None,
                        output_tail: Vec::new(),
                    });
                    self.tray.entries.len() - 1
                }
            };
            apply_progress_row(&mut self.tray.entries[i], p, self.tick);
        }
    }

    /// `role:"custom"` extension messages (teammate-complete, stalls, monitor
    /// notices) are user-facing when `display` isn't false — pi TUI renders
    /// them; map to `MsgKind::Custom` and settle matching tray rows.
    fn apply_custom_message_end(&mut self, v: &serde_json::Value) -> bool {
        if v.get("role").and_then(|r| r.as_str()) != Some("custom") {
            return false;
        }
        let mut changed = false;
        if v.get("customType").and_then(|t| t.as_str()) == Some("teammate-complete") {
            changed |= self.apply_teammate_progress(v.pointer("/details/progress"));
            changed |= self.settle_teammate_rows(v.pointer("/details/results"));
        }
        let monitoring_only = v
            .pointer("/details/monitoringOnly")
            .and_then(serde_json::Value::as_bool)
            == Some(true);
        if !monitoring_only && v.get("display") != Some(&serde_json::Value::Bool(false)) {
            if let Some(text) = custom_message_text(v) {
                self.push(Message::new(MsgKind::Custom, text));
                changed = true;
            }
        }
        changed
    }

    /// Fold a completion's `details.progress[]` into matching tray rows —
    /// carries the final `outputTail`/`lastMessage`/status per agent.
    fn apply_teammate_progress(&mut self, progress: Option<&serde_json::Value>) -> bool {
        let Some(progress) = progress.and_then(|p| p.as_array()) else {
            return false;
        };
        let mut changed = false;
        for p in progress {
            let Some(cid) = p.get("correlationId").and_then(|c| c.as_str()) else {
                continue;
            };
            for e in self.tray.entries.iter_mut() {
                if e.steer_target.as_deref() != Some(cid) && e.agent_key.as_deref() != Some(cid) {
                    continue;
                }
                apply_progress_row(e, p, self.tick);
                changed = true;
            }
        }
        changed
    }

    /// `teammate-complete` carries `details.results[]` with the settled
    /// agents' final output — close their tray rows and store the output so
    /// the preview/`v` view shows the real result, not the dispatch ack.
    fn settle_teammate_rows(&mut self, results: Option<&serde_json::Value>) -> bool {
        let Some(results) = results.and_then(|r| r.as_array()) else {
            return false;
        };
        let mut changed = false;
        for r in results {
            let Some(cid) = r.get("correlationId").and_then(|c| c.as_str()) else {
                continue;
            };
            let status = match r.get("completionOutcome").and_then(|o| o.as_str()) {
                Some("failed") => TrayStatus::Failed,
                Some("terminated") => TrayStatus::Cancelled,
                _ => TrayStatus::Done,
            };
            let output = r
                .get("output")
                .and_then(|o| o.as_str())
                .map(str::to_string)
                .or_else(|| {
                    r.get("structuredOutput")
                        .and_then(|s| serde_json::to_string_pretty(s).ok())
                });
            for e in self.tray.entries.iter_mut() {
                if e.steer_target.as_deref() != Some(cid) && e.agent_key.as_deref() != Some(cid) {
                    continue;
                }
                e.status = status;
                e.end_tick = Some(self.tick);
                if let Some(out) = &output {
                    if let Some(last) = out.lines().map(str::trim).rfind(|l| !l.is_empty()) {
                        e.last_message = last.to_string();
                    }
                }
                changed = true;
            }
        }
        changed
    }

    /// Toggle `expanded` on the collapsible message whose bubble node id
    /// is `node` (mouse click on a `data-hit-expand` region).
    pub fn toggle_tool_by_node(&mut self, node: blitz_dom::NodeId) -> bool {
        if let Some(m) = self.messages.iter_mut().find(|m| {
            (m.kind == MsgKind::Tool || m.kind == MsgKind::Thinking) && m.node_id == Some(node)
        }) {
            m.expanded = !m.expanded;
            m.dirty = true;
            self.dom_dirty = true;
            true
        } else {
            false
        }
    }
}

/// Extract the full display text of a tool result (for the card body).
/// Strings pass through; objects try `output`/`text`/`content` fields,
/// then pretty-printed JSON.
fn full_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        serde_json::Value::Object(map) => {
            for key in ["output", "text", "content", "stdout"] {
                if let Some(s) = map.get(key).and_then(|x| x.as_str()) {
                    return s.to_string();
                }
            }
            // Standard pi tool result: `content` is a typed block array
            // (`[{type:"text", text:"…"}, …]`) — join the text blocks.
            if let Some(blocks) = map.get("content").and_then(|x| x.as_array()) {
                let text: Vec<&str> = blocks
                    .iter()
                    .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                    .collect();
                if !text.is_empty() {
                    return text.join("\n");
                }
            }
            serde_json::to_string_pretty(v).unwrap_or_default()
        }
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// Display title for one `details.progress` snapshot row.
fn progress_row_title(p: &serde_json::Value) -> String {
    p.get("name")
        .and_then(|x| x.as_str())
        .or_else(|| p.get("agent").and_then(|x| x.as_str()))
        .map(str::to_string)
        .unwrap_or_else(|| "agent".to_string())
}

/// Map a teammate `AgentProgressStatus` onto the tray lifecycle.
fn agent_progress_status(s: &str) -> TrayStatus {
    match s {
        "completed" => TrayStatus::Done,
        "failed" | "terminated" => TrayStatus::Failed,
        _ => TrayStatus::Running,
    }
}

/// Text of a `role:"custom"` session message: `content` arrives as a plain
/// string or pi's content-block array.
fn custom_message_text(v: &serde_json::Value) -> Option<String> {
    match v.get("content") {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        Some(serde_json::Value::Array(blocks)) => {
            let text = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            (!text.trim().is_empty()).then_some(text)
        }
        _ => None,
    }
}

/// Fold one progress snapshot into a tray row: title, counters, recent
/// tools, lifecycle status (end tick stamped once on terminal states).
fn apply_progress_row(e: &mut TrayEntry, p: &serde_json::Value, tick: u64) {
    let title = progress_row_title(p);
    if title != "agent" {
        e.title = title;
    }
    if let Some(id) = p.get("correlationId").and_then(|x| x.as_str()) {
        e.steer_target = Some(id.to_string());
    }
    if let Some(t) = p.get("toolCount").and_then(|x| x.as_u64()) {
        e.tools = t as u32;
    }
    if let Some(model) = p.get("resolvedModel").and_then(|x| x.as_str()) {
        e.model = model.to_string();
    }
    if let Some(msg) = p.get("lastMessage").and_then(|x| x.as_str()) {
        if let Some(last) = msg.lines().map(str::trim).rfind(|l| !l.is_empty()) {
            e.last_message = last.to_string();
        }
    }
    if let Some(tail) = p.get("outputTail").and_then(|x| x.as_array()) {
        e.output_tail = tail
            .iter()
            .filter_map(|l| l.as_str().map(str::to_string))
            .collect();
    }
    if let Some(tools) = p.get("recentTools").and_then(|x| x.as_array()) {
        let recent: Vec<(String, String)> = tools
            .iter()
            .filter_map(|t| {
                let name = t.get("name").and_then(|x| x.as_str())?;
                let target = t
                    .get("argsPreview")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                Some((name.to_string(), target))
            })
            .collect();
        e.recent_tools = {
            let n = recent.len();
            recent.into_iter().skip(n.saturating_sub(6)).collect()
        };
    }
    let status = p.get("status").and_then(|x| x.as_str()).unwrap_or("running");
    let next = agent_progress_status(status);
    if next != e.status {
        e.status = next;
        if next != TrayStatus::Running && e.end_tick.is_none() {
            e.end_tick = Some(tick);
        }
    }
}

/// Teammate `details.progress` snapshot → per-agent status lines for
/// the card body: `[name] status · tools N · tokens N` plus the
/// agent's latest message tail.
fn agent_progress_text(v: &serde_json::Value) -> Option<String> {
    let progress = v.get("details")?.get("progress")?.as_array()?;
    if progress.is_empty() {
        return None;
    }
    let mut lines = Vec::new();
    for p in progress {
        let name = progress_row_title(p);
        let status = p.get("status").and_then(|x| x.as_str()).unwrap_or("running");
        let tools = p.get("toolCount").and_then(|x| x.as_u64()).unwrap_or(0);
        let tokens = p.get("tokens").and_then(|x| x.as_u64()).unwrap_or(0);
        lines.push(format!("[{name}] {status} · tools {tools} · tokens {tokens}"));
        if let Some(msg) = p.get("lastMessage").and_then(|x| x.as_str()) {
            if let Some(last) = msg.lines().map(str::trim).rfind(|l| !l.is_empty()) {
                lines.push(format!("  {last}"));
            }
        }
    }
    Some(lines.join("\n"))
}

/// Compact one-line summary of a tool args/result JSON value.
/// Extract a shell exit code from a tool result (`exit_code` /
/// `exitCode` / `code` at top level or under `details`/`result`).
fn extract_exit_code(v: &serde_json::Value) -> Option<i64> {
    for key in ["exit_code", "exitCode", "exit", "code"] {
        if let Some(n) = v.get(key).and_then(|x| x.as_i64()) {
            return Some(n);
        }
    }
    for key in ["details", "result", "output"] {
        if let Some(inner) = v.get(key) {
            if let Some(n) = extract_exit_code(inner) {
                return Some(n);
            }
        }
    }
    None
}

/// Current working directory for the status line — `~`-contracted, and
/// shortened to the last two components when still long.
fn display_cwd() -> String {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut s = cwd.to_string_lossy().replace('\\', "/");
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        let home = home.to_string_lossy().replace('\\', "/");
        if let Some(rest) = s.strip_prefix(&home) {
            s = format!("~{rest}");
        }
    }
    const MAX: usize = 40;
    if s.chars().count() > MAX {
        let tail: Vec<&str> = s.rsplit('/').filter(|p| !p.is_empty()).take(2).collect();
        if tail.len() == 2 {
            return format!("…/{}/{}", tail[1], tail[0]);
        }
    }
    s
}

/// Git branch from `.git/HEAD`, walking up from cwd — handles worktrees
/// where `.git` is a `gitdir: <path>` pointer file. Empty outside a repo.
fn detect_git_branch() -> String {
    let mut dir = std::env::current_dir().unwrap_or_default();
    let git_dir = loop {
        let candidate = dir.join(".git");
        if candidate.is_dir() {
            break candidate;
        }
        if candidate.is_file() {
            if let Ok(s) = std::fs::read_to_string(&candidate) {
                if let Some(p) = s.trim().strip_prefix("gitdir:") {
                    let p = p.trim();
                    let resolved = if std::path::Path::new(p).is_absolute() {
                        std::path::PathBuf::from(p)
                    } else {
                        dir.join(p)
                    };
                    if resolved.is_dir() {
                        break resolved;
                    }
                }
            }
        }
        if !dir.pop() {
            return String::new();
        }
    };
    let head = std::fs::read_to_string(git_dir.join("HEAD")).unwrap_or_default();
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref: refs/heads/") {
        r.to_string()
    } else if head.len() >= 7 {
        head[..7].to_string() // detached HEAD → short sha
    } else {
        String::new()
    }
}

fn summarize_args(v: &serde_json::Value) -> String {
    let s = match v {
        serde_json::Value::String(s) => s.clone(),
        other => {
            let j = serde_json::to_string(other).unwrap_or_default();
            j
        }
    };
    // Collapse whitespace/newlines for the single-line tool entry.
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    const MAX: usize = 120;
    if collapsed.chars().count() > MAX {
        let mut out: String = collapsed.chars().take(MAX - 1).collect();
        out.push('…');
        out
    } else {
        collapsed
    }
}

/// Extract displayable text from an `AgentMessage` (for `message_start`
/// dedup / history restore).
pub fn agent_message_text(msg: &AgentMessage) -> Option<(MsgKind, String)> {
    match msg {
        AgentMessage::User { content, .. } => {
            let text = match content {
                UserContent::Text(t) => t.clone(),
                UserContent::Parts(parts) => parts
                    .iter()
                    .filter_map(|p| match p {
                        MessageContent::Text { text, .. } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(""),
            };
            Some((MsgKind::User, text))
        }
        AgentMessage::Assistant { content, .. } => {
            let text = content
                .iter()
                .filter_map(|p| match p {
                    MessageContent::Text { text, .. } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");
            Some((MsgKind::Assistant, text))
        }
        AgentMessage::ToolResult {
            tool_name,
            is_error,
            ..
        } => Some((
            MsgKind::Tool,
            format!("{tool_name} {}", if *is_error { "✗" } else { "✓" }),
        )),
        AgentMessage::Unknown(_) => None,
    }
}

/// The human-readable detail of a failed assistant message: pi puts it
/// in `errorMessage` (a flattened extra on `role:"assistant"`).
fn assistant_error_message(msg: &AgentMessage) -> Option<String> {
    let extra = match msg {
        AgentMessage::Assistant { extra, .. } => Some(extra),
        AgentMessage::Unknown(v) => return v.get("errorMessage")?.as_str().map(str::to_string),
        _ => None,
    }?;
    extra
        .get("errorMessage")
        .or_else(|| extra.get("error"))
        .and_then(|e| e.as_str())
        .map(str::to_string)
}

/// Did the run end on an error? `agent_end.messages` carries the final
/// agent state — the last assistant message's `stopReason` tells.
fn agent_end_failed(messages: &[AgentMessage]) -> bool {
    for m in messages.iter().rev() {
        match m {
            AgentMessage::Assistant { stop_reason, .. } => return stop_reason == "error",
            AgentMessage::Unknown(v)
                if v.get("role").and_then(|r| r.as_str()) == Some("assistant") =>
            {
                return v.get("stopReason").and_then(|s| s.as_str()) == Some("error")
            }
            _ => {}
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(text: &str, cursor: usize) -> InputState {
        InputState {
            text: text.into(),
            cursor,
            ..Default::default()
        }
    }

    #[test]
    fn word_motion() {
        let mut i = input("foo  bar_baz qux", 0);
        i.move_word_right();
        assert_eq!(i.cursor, 3);
        i.move_word_right();
        assert_eq!(i.cursor, 12);
        i.move_word_left();
        assert_eq!(i.cursor, 5);
        i.move_word_left();
        assert_eq!(i.cursor, 0);
    }

    #[test]
    fn kill_line_variants() {
        // kill_line to EOL
        let mut i = input("hello world", 5);
        i.kill_line();
        assert_eq!(i.text, "hello");
        assert_eq!(i.kill_ring, [" world"]);
        // at EOL kills the newline
        let mut i = input("ab\ncd", 2);
        i.kill_line();
        assert_eq!(i.text, "abcd");
        // backward_kill_line to BOL
        let mut i = input("ab\ncdef", 5);
        i.backward_kill_line();
        assert_eq!(i.text, "ab\nef");
        assert_eq!(i.cursor, 3);
    }

    #[test]
    fn kill_words_and_yank() {
        let mut i = input("foo bar baz", 0);
        i.kill_word();
        assert_eq!(i.text, " bar baz");
        i.kill_word();
        assert_eq!(i.text, " baz");
        assert_eq!(i.kill_ring, ["foo", " bar"]);
        i.yank();
        assert_eq!(i.text, " bar baz");
        // backward kill word
        let mut i = input("foo bar", 7);
        i.backward_kill_word();
        assert_eq!(i.text, "foo ");
        // unix word rubout stops at whitespace only
        let mut i = input("foo/bar baz", 11);
        i.unix_word_rubout();
        assert_eq!(i.text, "foo/bar ");
    }

    #[test]
    fn undo_redo_restore_text_and_cursor() {
        let mut i = input("ab", 1);
        i.insert_char('x');
        assert_eq!((i.text.as_str(), i.cursor), ("axb", 2));
        i.undo();
        assert_eq!((i.text.as_str(), i.cursor), ("ab", 1));
        i.redo();
        assert_eq!((i.text.as_str(), i.cursor), ("axb", 2));

        let mut i = InputState::default();
        i.insert_char('a');
        i.insert_char('b');
        i.undo();
        assert_eq!((i.text.as_str(), i.cursor), ("", 0));
    }

    #[test]
    fn yank_pop_cycles_kill_ring() {
        let mut i = input("one two", 0);
        i.kill_word();
        i.kill_word();
        assert_eq!(i.kill_ring, ["one", " two"]);
        i.yank();
        assert_eq!(i.text, " two");
        i.yank_pop();
        assert_eq!(i.text, "one");
        i.yank_pop();
        assert_eq!(i.text, " two");
    }

    #[test]
    fn transpose_chars() {
        let mut i = input("ab", 1);
        i.transpose_chars();
        assert_eq!(i.text, "ba");
        assert_eq!(i.cursor, 2);
        // at EOL swaps the two before point
        let mut i = input("abc", 3);
        i.transpose_chars();
        assert_eq!(i.text, "acb");
    }

    #[test]
    fn transpose_words() {
        let mut i = input("foo bar", 4);
        i.transpose_words();
        assert_eq!(i.text, "bar foo");
        assert_eq!(i.cursor, 7);
        // cursor inside first word
        let mut i = input("foo bar", 1);
        i.transpose_words();
        assert_eq!(i.text, "bar foo");
    }

    #[test]
    fn case_words() {
        let mut i = input("foo BAR", 0);
        i.case_word(WordCase::Upper);
        assert_eq!(i.text, "FOO BAR");
        assert_eq!(i.cursor, 3);
        i.case_word(WordCase::Lower);
        assert_eq!(i.text, "FOO bar");
        let mut i = input("foo bar", 0);
        i.case_word(WordCase::Capitalize);
        assert_eq!(i.text, "Foo bar");
    }

    #[test]
    fn line_motion_multiline() {
        let mut i = input("abc\nde\nfghi", 6); // 'e' col 2 of line 2
        assert!(i.prev_line());
        assert_eq!(i.cursor, 2);
        assert!(i.next_line());
        assert_eq!(i.cursor, 6); // back to col 2 of line 2
                                 // clamp to shorter line
        let mut i = input("a\nbcd", 4);
        assert!(i.prev_line());
        assert_eq!(i.cursor, 1);
        // first line → false (caller falls back to history)
        let mut i = input("ab\ncd", 1);
        assert!(!i.prev_line());
        let mut i = input("ab\ncd", 4);
        assert!(!i.next_line());
    }

    #[test]
    fn history_search() {
        let mut i = input("car", 3);
        i.history = vec!["foo".into(), "cargo".into(), "bar".into(), "car2".into()];
        i.history_search();
        assert_eq!(i.text, "car2");
        i.history_search();
        assert_eq!(i.text, "cargo");
        i.history_search(); // no earlier match — stays
        assert_eq!(i.text, "cargo");
        // editing exits history mode
        i.insert_char('x');
        assert_eq!(i.history_idx, None);
    }

    #[test]
    fn passive_history_completion_is_display_only_until_accepted() {
        let mut state = AppState::new();
        state.input.history = vec!["cargo check".into(), "cargo test".into()];
        state.input.text = "cargo".into();
        state.input.cursor = state.input.text.len();
        state.update_completion();
        assert_eq!(state.input.ghost.as_deref(), Some(" test"));
        assert_eq!(state.input.text, "cargo");
        assert!(state.input.accept_ghost());
        assert_eq!(state.input.text, "cargo test");
        assert!(state.input.ghost.is_none());
    }

    #[test]
    fn home_end_are_line_based() {
        let mut i = input("ab\ncd", 4);
        i.move_home();
        assert_eq!(i.cursor, 3);
        i.move_end();
        assert_eq!(i.cursor, 5);
    }

    #[test]
    fn scrollback_search_marks_and_steps() {
        let mut state = AppState::new();
        state.push_user("refactor the parser");
        state.push(Message::new(MsgKind::Assistant, "sure, parser it is"));
        state.push_system("unrelated note");
        let mut s = SearchState {
            query: "parser".into(),
            ..Default::default()
        };
        let cur = s.refresh(&mut state.messages);
        assert_eq!(s.matches, vec![0, 1]);
        assert_eq!(cur, Some(1)); // cursor clamps to last match
        assert_eq!(state.messages[1].search_mark, SearchMark::Current);
        assert_eq!(state.messages[0].search_mark, SearchMark::Hit);
        assert_eq!(state.messages[2].search_mark, SearchMark::None);
        // step wraps forward to the first match
        let cur = s.step(&mut state.messages, 1);
        assert_eq!(cur, Some(0));
        assert_eq!(state.messages[0].search_mark, SearchMark::Current);
        assert_eq!(state.messages[1].search_mark, SearchMark::Hit);
        // narrowing the query re-marks
        s.query = "refactor".into();
        let cur = s.refresh(&mut state.messages);
        assert_eq!(cur, Some(0));
        assert_eq!(s.matches, vec![0]);
        // clearing the query drops all marks
        s.query.clear();
        assert_eq!(s.refresh(&mut state.messages), None);
        assert!(state
            .messages
            .iter()
            .all(|m| m.search_mark == SearchMark::None));
    }

    fn select_req(id: &str) -> RpcExtensionUIRequest {
        RpcExtensionUIRequest::Select {
            id: id.into(),
            title: format!("q{id}"),
            options: vec!["a".into(), "b".into()],
            timeout: None,
        }
    }

    #[test]
    fn deferred_questions_rotate_ring_and_resolve_in_display_order() {
        let mut state = AppState::new();
        // Three selects arrive; first opens, rest queue.
        state.open_ui(&select_req("1"));
        state.open_ui(&select_req("2"));
        state.open_ui(&select_req("3"));
        assert!(matches!(state.dialog, Some(DialogState::Select { .. })));
        assert_eq!(state.pending_ui.len(), 2);
        assert_eq!(state.q_indicator().as_deref(), Some("[q 1/3]"));

        // Defer to next: q2 promoted, q1 re-queues at back.
        assert!(state.defer_question(1));
        let Some(DialogState::Select { id, .. }) = &state.dialog else {
            panic!("expected select dialog")
        };
        assert_eq!(id, "2");
        assert_eq!(state.q_indicator().as_deref(), Some("[q 2/3]"));

        // Defer to prev: q1 comes back around the ring.
        assert!(state.defer_question(-1));
        let Some(DialogState::Select { id, .. }) = &state.dialog else {
            panic!("expected select dialog")
        };
        assert_eq!(id, "1");
        assert_eq!(state.q_indicator().as_deref(), Some("[q 1/3]"));

        // Resolving sends only the displayed question's response and
        // promotes the next queued one.
        state.resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value {
            id: "1".into(),
            value: "a".into(),
        });
        assert!(matches!(
            state.dialog_result,
            Some(pi_rpc::RpcExtensionUIResponse::Value { .. })
        ));
        let Some(DialogState::Select { id, .. }) = &state.dialog else {
            panic!("expected promoted select")
        };
        assert_eq!(id, "2");

        // Drain the ring; indicator disappears when nothing is queued.
        state.resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value {
            id: "2".into(),
            value: "b".into(),
        });
        state.resolve_dialog(pi_rpc::RpcExtensionUIResponse::Value {
            id: "3".into(),
            value: "a".into(),
        });
        assert!(state.dialog.is_none());
        assert_eq!(state.q_indicator(), None);
    }

    fn entries_response(entries: serde_json::Value) -> RpcResponse {
        RpcResponse {
            id: None,
            kind: "response".into(),
            command: "get_entries".into(),
            success: true,
            data: Some(serde_json::json!({ "entries": entries })),
            error: None,
        }
    }

    fn todo_entry(tasks: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "id": "e1",
            "type": "custom",
            "customType": "todo-state",
            "data": { "tasks": tasks }
        })
    }

    #[test]
    fn hydrate_todos_reads_latest_todo_state_entry() {
        let mut state = AppState::new();
        let resp = entries_response(serde_json::json!([
            { "id": "e0", "type": "message" },
            todo_entry(serde_json::json!({
                "task-1": { "subject": "first pass", "status": "completed" },
                "task-2": { "subject": "wip", "status": "in_progress" },
                "task-3": { "subject": "waiting", "status": "blocked" },
                "task-4": { "subject": "gone", "status": "deleted" },
                "task-5": { "subject": "later", "status": "pending" }
            }))
        ]));
        assert!(state.hydrate_todos(&resp));
        assert_eq!(state.todos.len(), 4);
        let by_id = |id: &str| state.todos.iter().find(|t| t.id == id).unwrap();
        assert_eq!(by_id("task-1").status, TodoStatus::Completed);
        assert_eq!(by_id("task-2").status, TodoStatus::InProgress);
        assert_eq!(by_id("task-3").status, TodoStatus::Blocked);
        assert_eq!(by_id("task-5").status, TodoStatus::Pending);
        // Same response again → no change.
        assert!(!state.hydrate_todos(&resp));
    }

    #[test]
    fn hydrate_todos_strips_control_chars_and_newer_entry_wins() {
        let mut state = AppState::new();
        let resp = entries_response(serde_json::json!([
            todo_entry(serde_json::json!({
                "task-1": { "subject": "stale", "status": "pending" }
            })),
            todo_entry(serde_json::json!({
                "task-9": { "subject": "a\u{1b}[31mline\nbreak", "status": "in-progress" }
            }))
        ]));
        assert!(state.hydrate_todos(&resp));
        assert_eq!(state.todos.len(), 1);
        assert_eq!(state.todos[0].id, "task-9");
        assert_eq!(state.todos[0].status, TodoStatus::InProgress);
        assert_eq!(state.todos[0].subject, "a[31mlinebreak");
    }

    #[test]
    fn hydrate_todos_without_todo_entry_clears_or_keeps() {
        let mut state = AppState::new();
        let resp = entries_response(serde_json::json!([
            { "id": "e0", "type": "message" }
        ]));
        // No todo-state entry yet → nothing rendered.
        assert!(!state.hydrate_todos(&resp));
        assert!(state.todos.is_empty());
    }

    #[test]
    fn extension_commands_are_detected_by_source() {
        let mut state = AppState::new();
        state.pi_commands = vec![
            ("deploy".into(), "Ship it (extension)".into(), "extension".into()),
            ("review".into(), "Review (skill)".into(), "skill".into()),
            ("tmpl".into(), "Tpl (prompt)".into(), "prompt".into()),
        ];
        assert!(state.is_extension_command("deploy"));
        assert!(!state.is_extension_command("review"));
        assert!(!state.is_extension_command("tmpl"));
        assert!(!state.is_extension_command("unknown"));
    }

    #[test]
    fn running_shells_counts_bg_and_ssh() {
        let mut tray = TrayState::default();
        let entry = |title: &str, kind, status| TrayEntry {
            kind,
            title: title.to_string(),
            tool: "bash".into(),
            model: String::new(),
            color_idx: 0,
            status,
            tools: 0,
            recent_tools: Vec::new(),
            start_tick: 0,
            end_tick: None,
            msg_idx: 0,
            foregrounded: false,
            call_id: String::new(),
            agent_key: None,
            last_message: String::new(),
            steer_target: None,
            output_tail: Vec::new(),
        };
        tray.entries.push(entry("tail -f log", TrayKind::Shell, TrayStatus::Running));
        tray.entries.push(entry("ssh host uptime", TrayKind::Shell, TrayStatus::Running));
        tray.entries.push(entry("ssh old", TrayKind::Shell, TrayStatus::Done));
        tray.entries.push(entry("agent run", TrayKind::Subagent, TrayStatus::Running));
        assert_eq!(tray.running_shells(), (2, 1));
    }
}
