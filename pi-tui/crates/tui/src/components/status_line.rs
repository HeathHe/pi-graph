//! `StatusLine` — compact, semantically styled session state.
//!
//! DOM shape:
//! ```text
//! #status-line
//!   ├─ #status-left
//!   │    ├─ .status-model
//!   │    ├─ .status-permission
//!   │    ├─ .status-thinking
//!   │    ├─ .status-mode
//!   │    ├─ .status-cwd
//!   │    ├─ .status-git
//!   │    ├─ .status-running
//!   │    ├─ .status-agent
//!   │    ├─ .status-queue
//!   │    ├─ .status-bg
//!   │    ├─ .status-ssh
//!   │    └─ .status-transient
//!   └─ #status-right  (cockpit-style resource group)
//!        ├─ .status-ctx     "[██████░░░░] 42% 86k/200k"
//!        ├─ .status-tok-in  "↑12k"     (accent)
//!        ├─ .status-tok-out "↓3k"      (success)
//!        └─ .status-cost    "$0.42"    (warning)
//! ```

use blitz_dom::{DocumentMutator, NodeId};

use crate::components::dom::{div, qual, span_text};
use crate::components::glyphs::GlyphMode;
use crate::state::{PermissionMode, StatusState};

/// Node ids patched when status changes.
#[derive(Clone, Copy)]
pub struct StatusLineHandles {
    pub model_text: NodeId,
    pub permission_span: NodeId,
    pub permission_text: NodeId,
    pub thinking_text: NodeId,
    pub mode_text: NodeId,
    pub cwd_text: NodeId,
    pub git_text: NodeId,
    pub running_text: NodeId,
    pub agent_text: NodeId,
    pub queue_text: NodeId,
    pub bg_text: NodeId,
    pub ssh_text: NodeId,
    pub transient_text: NodeId,
    pub ctx_span: NodeId,
    pub ctx_text: NodeId,
    pub tok_in_text: NodeId,
    pub tok_out_text: NodeId,
    pub cost_text: NodeId,
}

/// Build the status line under `parent`.
pub fn build(m: &mut DocumentMutator<'_>, parent: NodeId) -> StatusLineHandles {
    let line = div(m, parent, "");
    m.set_attribute(line, qual("id"), "status-line");

    let left = div(m, line, "");
    m.set_attribute(left, qual("id"), "status-left");
    let (_, model_text) = span_text(m, left, "status-model", "");
    let (permission_span, permission_text) = span_text(m, left, "status-permission", "");
    let (_, thinking_text) = span_text(m, left, "status-thinking", "");
    let (_, mode_text) = span_text(m, left, "status-mode", "");
    let (_, cwd_text) = span_text(m, left, "status-cwd", "");
    let (_, git_text) = span_text(m, left, "status-git", "");
    let (_, running_text) = span_text(m, left, "status-running", "");
    let (_, agent_text) = span_text(m, left, "status-agent", "");
    let (_, queue_text) = span_text(m, left, "status-queue", "");
    let (_, bg_text) = span_text(m, left, "status-bg", "");
    let (_, ssh_text) = span_text(m, left, "status-ssh", "");
    let (_, transient_text) = span_text(m, left, "status-transient", "");

    let right = div(m, line, "");
    m.set_attribute(right, qual("id"), "status-right");
    let (ctx_span, ctx_text) = span_text(m, right, "status-ctx status-ctx-ok", "");
    let (_, tok_in_text) = span_text(m, right, "status-tok-in", "");
    let (_, tok_out_text) = span_text(m, right, "status-tok-out", "");
    let (_, cost_text) = span_text(m, right, "status-cost", "");

    StatusLineHandles {
        model_text,
        permission_span,
        permission_text,
        thinking_text,
        mode_text,
        cwd_text,
        git_text,
        running_text,
        agent_text,
        queue_text,
        bg_text,
        ssh_text,
        transient_text,
        ctx_span,
        ctx_text,
        tok_in_text,
        tok_out_text,
        cost_text,
    }
}

fn set_segment(
    m: &mut DocumentMutator<'_>,
    text_node: NodeId,
    text: impl AsRef<str>,
    populated: &mut bool,
) {
    let text = text.as_ref();
    if text.is_empty() {
        m.set_node_text(text_node, "");
        return;
    }
    let prefix = if *populated { " · " } else { "" };
    m.set_node_text(text_node, &format!("{prefix}{text}"));
    *populated = true;
}

fn permission_label(permission: PermissionMode) -> &'static str {
    match permission {
        PermissionMode::Normal => "perm normal",
        PermissionMode::AcceptEdits => "perm edits",
        PermissionMode::Smart => "perm smart",
        PermissionMode::Plan => "perm plan",
        PermissionMode::Ask => "perm ask",
        PermissionMode::Bypass => "perm bypass",
        PermissionMode::Autonomous => "perm auto",
    }
}

fn permission_class(permission: PermissionMode) -> &'static str {
    match permission {
        PermissionMode::Normal => "status-permission",
        PermissionMode::AcceptEdits | PermissionMode::Smart => "status-permission status-accent",
        PermissionMode::Plan | PermissionMode::Ask => "status-permission status-info",
        PermissionMode::Bypass | PermissionMode::Autonomous => "status-permission status-warn",
    }
}

fn input_mode_label(mode: &str) -> String {
    match mode.strip_prefix("send:").unwrap_or(mode) {
        "follow-up" | "follow_up" | "followup" => "input follow-up".to_string(),
        "steer" => "input steer".to_string(),
        other => other.replace('_', " "),
    }
}

/// Compact token count: `1234 → "1.2k"`, `1_000_000 → "1.0m"`.
fn fmt_tokens(n: u64) -> String {
    let trim = |x: f64| {
        let s = format!("{x:.1}");
        s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
    };
    if n >= 1_000_000 {
        format!("{}m", trim(n as f64 / 1_000_000.0))
    } else if n >= 1_000 {
        format!("{}k", trim(n as f64 / 1_000.0))
    } else {
        n.to_string()
    }
}

/// USD cost (cockpit `fmtCost`): cents below $1, 2 decimals above,
/// compact k above $1k; sub-cent keeps significant digits.
fn fmt_cost(n: f64) -> String {
    if n >= 1_000.0 {
        format!("{}k", fmt_tokens_trim(n / 1_000.0))
    } else if n >= 100.0 {
        format!("{}", n.round() as u64)
    } else if n >= 0.01 {
        format!("{n:.2}")
    } else {
        let s = format!("{n:.4}");
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

fn fmt_tokens_trim(x: f64) -> String {
    let s = format!("{x:.1}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

const CONTEXT_WARN_PCT: f64 = 70.0;
const CONTEXT_CRIT_PCT: f64 = 90.0;

fn ctx_class(pct: f64) -> &'static str {
    if pct >= CONTEXT_CRIT_PCT {
        "status-ctx status-ctx-crit"
    } else if pct >= CONTEXT_WARN_PCT {
        "status-ctx status-ctx-warn"
    } else {
        "status-ctx status-ctx-ok"
    }
}

/// Cockpit context meter: `[██████░░░░] 42% 86k/200k`.
fn ctx_text(pct: f64, tokens: u64, window: u64, mode: GlyphMode) -> String {
    const W: usize = 10;
    let filled = ((pct.clamp(0.0, 100.0) / 100.0) * W as f64).round() as usize;
    let (done, pending) = if mode == GlyphMode::Unicode {
        ("█", "░")
    } else {
        ("#", "-")
    };
    let shown = pct.round().min(100.0) as u64;
    format!(
        "[{}{}] {}% {}/{}",
        done.repeat(filled.min(W)),
        pending.repeat(W - filled.min(W)),
        shown,
        fmt_tokens(tokens),
        fmt_tokens(window),
    )
}

/// Sync the status line from session state. Every state keeps a textual
/// cue; color only reinforces meaning.
pub fn sync(
    m: &mut DocumentMutator<'_>,
    handles: &StatusLineHandles,
    status: &StatusState,
    streaming: bool,
    permission: PermissionMode,
    queued: usize,
    bg: usize,
    ssh: usize,
    agent: Option<&str>,
    mode: GlyphMode,
) {
    let mut populated = false;
    set_segment(m, handles.model_text, &status.model, &mut populated);
    m.set_attribute(
        handles.permission_span,
        qual("class"),
        permission_class(permission),
    );
    set_segment(
        m,
        handles.permission_text,
        permission_label(permission),
        &mut populated,
    );
    set_segment(
        m,
        handles.thinking_text,
        if status.thinking.is_empty() {
            String::new()
        } else {
            format!("think {}", status.thinking)
        },
        &mut populated,
    );
    set_segment(
        m,
        handles.mode_text,
        input_mode_label(&status.mode),
        &mut populated,
    );
    set_segment(m, handles.cwd_text, &status.cwd, &mut populated);
    set_segment(
        m,
        handles.git_text,
        if status.git_branch.is_empty() {
            String::new()
        } else {
            format!("⎇ {}", status.git_branch)
        },
        &mut populated,
    );
    set_segment(
        m,
        handles.running_text,
        if streaming { "● running" } else { "" },
        &mut populated,
    );
    set_segment(
        m,
        handles.agent_text,
        agent.map(|t| format!("[~] {t}")).unwrap_or_default(),
        &mut populated,
    );
    set_segment(
        m,
        handles.queue_text,
        if queued > 0 {
            format!("{queued} queued")
        } else {
            String::new()
        },
        &mut populated,
    );
    set_segment(
        m,
        handles.bg_text,
        if bg > 0 {
            format!("bg {bg}")
        } else {
            String::new()
        },
        &mut populated,
    );
    set_segment(
        m,
        handles.ssh_text,
        if ssh > 0 {
            format!("ssh {ssh}")
        } else {
            String::new()
        },
        &mut populated,
    );
    set_segment(m, handles.transient_text, &status.transient, &mut populated);
    if !populated {
        m.set_node_text(handles.model_text, "pi");
    }

    // Right resource group (cockpit): context bar → in/out tokens → cost.
    let mut rpop = false;
    if status.context_window > 0 {
        let pct = status.context_tokens as f64 / status.context_window as f64 * 100.0;
        m.set_attribute(handles.ctx_span, qual("class"), ctx_class(pct));
        set_segment(
            m,
            handles.ctx_text,
            ctx_text(pct, status.context_tokens, status.context_window, mode),
            &mut rpop,
        );
    } else {
        m.set_node_text(handles.ctx_text, "");
    }
    set_segment(
        m,
        handles.tok_in_text,
        if status.input_tokens > 0 {
            format!("{}{}", mode.arrow_up(), fmt_tokens(status.input_tokens))
        } else {
            String::new()
        },
        &mut rpop,
    );
    set_segment(
        m,
        handles.tok_out_text,
        if status.output_tokens > 0 {
            format!("{}{}", mode.arrow_down(), fmt_tokens(status.output_tokens))
        } else {
            String::new()
        },
        &mut rpop,
    );
    set_segment(
        m,
        handles.cost_text,
        if status.cost > 0.0 {
            format!("${}", fmt_cost(status.cost))
        } else {
            String::new()
        },
        &mut rpop,
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_input_modes_for_people() {
        assert_eq!(input_mode_label("send:follow-up"), "input follow-up");
        assert_eq!(input_mode_label("send:steer"), "input steer");
        assert_eq!(input_mode_label("one_at_a_time"), "one at a time");
    }

    #[test]
    fn risky_permissions_keep_a_warning_class() {
        assert!(permission_class(PermissionMode::Bypass).contains("status-warn"));
        assert!(permission_class(PermissionMode::Autonomous).contains("status-warn"));
        assert_eq!(permission_label(PermissionMode::Plan), "perm plan");
    }

    #[test]
    fn token_and_cost_formats() {
        assert_eq!(fmt_tokens(42), "42");
        assert_eq!(fmt_tokens(12_300), "12.3k");
        assert_eq!(fmt_tokens(2_000_000), "2m");
        assert_eq!(fmt_cost(0.0), "0");
        assert_eq!(fmt_cost(0.42), "0.42");
        assert_eq!(fmt_cost(0.008), "0.008");
        assert_eq!(fmt_cost(1234.5), "1.2k");
    }

    #[test]
    fn ctx_class_thresholds() {
        assert!(ctx_class(0.0).contains("status-ctx-ok"));
        assert!(ctx_class(69.9).contains("status-ctx-ok"));
        assert!(ctx_class(70.0).contains("status-ctx-warn"));
        assert!(ctx_class(89.9).contains("status-ctx-warn"));
        assert!(ctx_class(90.0).contains("status-ctx-crit"));
        assert!(ctx_class(150.0).contains("status-ctx-crit"));
    }

    #[test]
    fn ctx_meter_renders_bar_and_clamps() {
        let s = ctx_text(42.0, 86_000, 200_000, GlyphMode::Unicode);
        assert!(s.contains("42%"));
        assert!(s.contains("86k/200k"));
        assert!(s.contains("████"));
        let over = ctx_text(137.0, 200_000, 200_000, GlyphMode::Ascii);
        assert!(over.contains("100%"));
        assert!(over.contains("##########"));
    }
}
