//! Slash-command parsing.
//!
//! In RPC mode pi's built-in slash commands are the client's job: pi only
//! exposes primitives (`set_model`, `compact`, `new_session`, …). Commands
//! we don't own are forwarded verbatim as a `prompt` — pi resolves
//! extension/prompt/skill commands server-side (`get_commands`).

/// What a submitted input line resolves to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Command {
    /// Send to pi as a `prompt` (plain text or an unknown `/x`).
    Prompt(String),
    /// Handled locally (maps to an RPC primitive or pure UI action).
    Local(LocalCmd),
}

/// Locally-handled slash commands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LocalCmd {
    /// `/model` → picker; `/model provider/id` → direct set.
    Model(Option<String>),
    /// `/thinking` → picker; `/thinking <level>` → direct set.
    Thinking(Option<String>),
    /// `/new` — start a fresh session.
    NewSession,
    /// `/resume` — pick a current-session entry to fork from.
    Resume,
    /// `/tree` — pick a node in the current session tree to fork from.
    Tree,
    /// `/fork` — pick a user message to fork from.
    Fork,
    /// `/clone` — clone the current session at its leaf.
    Clone,
    /// `/import <path>` — switch to the session file at `path`.
    Import(String),
    /// Command exists upstream but has no RPC primitive.
    Unsupported(&'static str),
    /// `/compact [instructions]`.
    Compact(Option<String>),
    /// `/session` — stats as a system line.
    Session,
    /// `/export [path]` — HTML export.
    Export(Option<String>),
    /// `/name <name>` — session display name.
    Name(String),
    /// `/copy` — last assistant text to clipboard.
    Copy,
    /// `/clear` — clear the message list (same as Ctrl+L).
    Clear,
    /// `/settings` — local boolean toggles picker.
    Settings,
    /// `/theme` → picker; `/theme <name>` → direct set; `/theme auto` → detect.
    Theme(Option<String>),
    /// `/unqueue` — recall the last queued (follow-up) message.
    Unqueue,
    /// `/help` — list built-in + pi-reported commands.
    Help,
    /// `/quit` / `/exit`.
    Quit,
}

/// Parse a submitted input line. `input` is the raw text (no leading
/// whitespace trimmed by the caller).
pub fn parse(input: &str) -> Command {
    let text = input.trim();
    if !text.starts_with('/') || text == "/" {
        return Command::Prompt(input.to_string());
    }
    // Split "/name args…" at the first whitespace.
    let body = &text[1..];
    let (name, args) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], body[i..].trim()),
        None => (body, ""),
    };
    let args = if args.is_empty() {
        None
    } else {
        Some(args.to_string())
    };
    let local = match name {
        "model" | "m" => LocalCmd::Model(args),
        "thinking" | "think" | "t" => LocalCmd::Thinking(args),
        "new" => LocalCmd::NewSession,
        "resume" => LocalCmd::Resume,
        "tree" => LocalCmd::Tree,
        "fork" => LocalCmd::Fork,
        "clone" => LocalCmd::Clone,
        "import" => match args {
            Some(path) => LocalCmd::Import(path),
            None => return Command::Prompt(input.to_string()),
        },
        "share" => LocalCmd::Unsupported("share"),
        "login" => LocalCmd::Unsupported("login"),
        "logout" => LocalCmd::Unsupported("logout"),
        "compact" => LocalCmd::Compact(args),
        "session" | "stats" => LocalCmd::Session,
        "export" => LocalCmd::Export(args),
        "name" => match args {
            Some(n) => LocalCmd::Name(n),
            None => return Command::Prompt(input.to_string()),
        },
        "copy" => LocalCmd::Copy,
        "clear" | "cls" => LocalCmd::Clear,
        "settings" | "setting" => LocalCmd::Settings,
        "theme" => LocalCmd::Theme(args),
        "unqueue" => LocalCmd::Unqueue,
        "help" | "h" | "?" => LocalCmd::Help,
        "quit" | "exit" | "q" => LocalCmd::Quit,
        _ => return Command::Prompt(input.to_string()),
    };
    Command::Local(local)
}

/// Built-in command list for `/help` output.
pub const BUILTIN_HELP: &[(&str, &str)] = &[
    ("/model [provider/id]", "select or switch model"),
    ("/thinking [level]", "select or set thinking level"),
    ("/new", "start a new session"),
    (
        "/resume",
        "pick a current-session entry to fork (RPC has no session list)",
    ),
    ("/tree", "pick a current-session tree node to fork"),
    ("/fork", "pick a user message to fork from"),
    ("/clone", "clone the current session at its leaf"),
    ("/import <path>", "switch to a session file"),
    ("/share", "not supported over RPC"),
    ("/login", "not supported over RPC"),
    ("/logout", "not supported over RPC"),
    ("/compact [instructions]", "compact session context"),
    ("/session", "session stats"),
    ("/export [path]", "export session as HTML"),
    ("/name <name>", "set session display name"),
    ("/copy", "copy last assistant message"),
    ("/clear", "clear the message list"),
    ("/settings", "toggle local settings"),
    ("/theme [name]", "select or set color theme"),
    ("/unqueue", "recall last queued message"),
    ("/help", "this list"),
    ("/quit", "exit"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_is_prompt() {
        assert_eq!(parse("hello"), Command::Prompt("hello".into()));
        assert_eq!(parse("  spaced  "), Command::Prompt("  spaced  ".into()));
        assert_eq!(parse("/"), Command::Prompt("/".into()));
    }

    #[test]
    fn known_commands() {
        assert_eq!(parse("/model"), Command::Local(LocalCmd::Model(None)));
        assert_eq!(
            parse("/model kimi/k3"),
            Command::Local(LocalCmd::Model(Some("kimi/k3".into())))
        );
        assert_eq!(
            parse("/thinking high"),
            Command::Local(LocalCmd::Thinking(Some("high".into())))
        );
        assert_eq!(parse("/new"), Command::Local(LocalCmd::NewSession));
        assert_eq!(parse("/resume"), Command::Local(LocalCmd::Resume));
        assert_eq!(parse("/tree"), Command::Local(LocalCmd::Tree));
        assert_eq!(parse("/fork"), Command::Local(LocalCmd::Fork));
        assert_eq!(parse("/clone"), Command::Local(LocalCmd::Clone));
        assert_eq!(
            parse("/import sessions/work.jsonl"),
            Command::Local(LocalCmd::Import("sessions/work.jsonl".into()))
        );
        assert_eq!(
            parse("/share"),
            Command::Local(LocalCmd::Unsupported("share"))
        );
        assert_eq!(
            parse("/login"),
            Command::Local(LocalCmd::Unsupported("login"))
        );
        assert_eq!(
            parse("/logout"),
            Command::Local(LocalCmd::Unsupported("logout"))
        );
        assert_eq!(
            parse("/compact keep the diff"),
            Command::Local(LocalCmd::Compact(Some("keep the diff".into())))
        );
        assert_eq!(parse("/session"), Command::Local(LocalCmd::Session));
        assert_eq!(
            parse("/export out.html"),
            Command::Local(LocalCmd::Export(Some("out.html".into())))
        );
        assert_eq!(
            parse("/name my session"),
            Command::Local(LocalCmd::Name("my session".into()))
        );
        assert_eq!(parse("/copy"), Command::Local(LocalCmd::Copy));
        assert_eq!(parse("/clear"), Command::Local(LocalCmd::Clear));
        assert_eq!(parse("/settings"), Command::Local(LocalCmd::Settings));
        assert_eq!(parse("/theme"), Command::Local(LocalCmd::Theme(None)));
        assert_eq!(
            parse("/theme nord"),
            Command::Local(LocalCmd::Theme(Some("nord".into())))
        );
        assert_eq!(parse("/unqueue"), Command::Local(LocalCmd::Unqueue));
        assert_eq!(parse("/help"), Command::Local(LocalCmd::Help));
        assert_eq!(parse("/quit"), Command::Local(LocalCmd::Quit));
        assert_eq!(parse("/exit"), Command::Local(LocalCmd::Quit));
    }

    #[test]
    fn unknown_and_bare_args_forward() {
        // Unknown slash commands go to pi verbatim (skill/extension cmds).
        assert_eq!(parse("/review src"), Command::Prompt("/review src".into()));
        assert_eq!(parse("/foo"), Command::Prompt("/foo".into()));
        // Commands requiring an argument are forwarded unchanged when bare.
        assert_eq!(parse("/name"), Command::Prompt("/name".into()));
        assert_eq!(parse("/import"), Command::Prompt("/import".into()));
    }
}
