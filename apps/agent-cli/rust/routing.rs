//! Syntax only. Every route names a domain command or an unsupported result.
use anyhow::{Result, bail, ensure};
use serde_json::{Value, json};

pub const COMMANDS: &[&str] = &[
    "help",
    "conversations",
    "new",
    "select",
    "identity",
    "remit",
    "memories",
    "correct",
    "forget",
    "artifacts",
    "artifact",
    "work",
    "status",
    "steer",
    "cancel",
    "approvals",
    "approve",
    "deny",
    "models",
    "exit",
];
pub const METHODS: &[&str] = &[
    "agent.get",
    "identity.set",
    "conversation.list",
    "conversation.open",
    "conversation.new",
    "conversation.snapshot",
    "conversation.replay",
    "conversation.history",
    "memory.list",
    "memory.correct",
    "memory.forget",
    "turn.submit",
    "turn.steer",
    "turn.cancel",
    "approval.propose",
    "approval.resolve",
    "work.update",
    "artifact.get",
    "artifact.list",
    "work.list",
    "approval.list",
    "work.status",
];
pub const HELP: &str = "Stokd Agent\n\nstokd-agent create <name> [--identity <text>] [--remit <text>]\nstokd-agent list\nstokd-agent chat <name> [--fullscreen|--inline]\nstokd-agent import-poc\nstokd-agent command <name> <command> [arguments]\nstokd-agent rpc <method> <JSON parameters>\n\nIn the TUI:\n/conversations · /new [title] · /select <conversation-id>\n/identity [text] · /remit [text]\n/memories · /correct <id> <revision> <text> · /forget <id> <revision>\n/artifacts · /artifact <id> · /work · /status\n/steer <text> · /cancel · /approvals\n/approve <approval-id> · /deny <approval-id>\n/models · /help · /exit\n\nEnter sends. While running, Enter steers by cancelling the unfinished generation and sending the new instruction. Escape cancels a running turn when the draft is empty. Ctrl+C clears the draft, then cancels work, then exits. PageUp/PageDown scroll. Ctrl+B opens conversations. Ctrl+P with an empty draft loads older messages; Ctrl+L returns to latest.\n\nShell prefixes, native session/model changes, donor plugins/presets/reload, file writes, editor commands and profile inheritance are unsupported. Artifacts are stored in the agent database. No external work executor is configured.";

pub fn slash(agent: &str, conversation: &str, line: &str) -> Result<(String, Value)> {
    let mut p = json!({"agent":agent,"conversationId":conversation});
    if !line.starts_with('/') {
        ensure!(
            !line.starts_with('!') && !line.starts_with('$'),
            "Unsupported command: shell prefixes"
        );
        p["text"] = json!(line);
        return Ok(("turn.submit".into(), p));
    }
    let (command, rest) = line[1..]
        .split_once(char::is_whitespace)
        .unwrap_or((&line[1..], ""));
    let rest = rest.trim();
    let method = match command {
        "help" => "system.help",
        "conversations" => "conversation.list",
        "new" => {
            if !rest.is_empty() {
                p["title"] = json!(rest);
            }
            "conversation.new"
        }
        "select" => {
            p["conversationId"] = json!(rest);
            "conversation.open"
        }
        "identity" | "remit" => {
            if rest.is_empty() {
                "agent.get"
            } else {
                p[command] = json!(rest);
                "identity.set"
            }
        }
        "memories" => "memory.list",
        "correct" | "forget" => {
            let mut parts = rest.splitn(3, char::is_whitespace);
            p["id"] = json!(parts.next().unwrap_or_default());
            p["revision"] =
                json!(parts.next().unwrap_or_default().parse::<i64>().map_err(
                    |_| anyhow::anyhow!("Usage: /{command} <memory-id> <revision> [text]")
                )?);
            if command == "correct" {
                p["content"] = json!(parts.next().unwrap_or_default());
                "memory.correct"
            } else {
                "memory.forget"
            }
        }
        "artifacts" => "artifact.list",
        "artifact" => {
            p["id"] = json!(rest);
            "artifact.get"
        }
        "work" => "work.list",
        "status" => "work.status",
        "steer" => {
            p["text"] = json!(rest);
            "turn.steer"
        }
        "cancel" => "turn.cancel",
        "approvals" => "approval.list",
        "approve" | "deny" => {
            p["id"] = json!(rest);
            p["allow"] = json!(command == "approve");
            "approval.resolve"
        }
        "models" => "model.list",
        "exit" | "quit" => "view.exit",
        _ => bail!("Unsupported command: /{command}"),
    };
    Ok((method.into(), p))
}

pub fn cli(args: &[String]) -> Result<(String, Value)> {
    let arg = |index| args.get(index).map(String::as_str).unwrap_or_default();
    match arg(0) {
        "create" => {
            let mut p = json!({"name":arg(1)});
            let mut i = 2;
            while i < args.len() {
                ensure!(
                    matches!(arg(i), "--identity" | "--remit"),
                    "Unsupported option: {}",
                    arg(i)
                );
                ensure!(i + 1 < args.len(), "Option requires text");
                p[&arg(i)[2..]] = json!(arg(i + 1));
                i += 2;
            }
            Ok(("agent.create".into(), p))
        }
        "list" => {
            ensure!(args.len() == 1, "Usage: stokd-agent list");
            Ok(("agent.list".into(), json!({})))
        }
        "chat" => {
            ensure!(!arg(1).is_empty(), "Usage: stokd-agent chat <name>");
            ensure!(
                args.iter()
                    .skip(2)
                    .all(|a| matches!(a.as_str(), "--fullscreen" | "--inline")),
                "Unsupported chat option"
            );
            Ok((
                "view.chat".into(),
                json!({"agent":arg(1),"fullscreen":args.iter().any(|a|a=="--fullscreen")}),
            ))
        }
        "help" | "--help" | "-h" | "" => Ok(("system.help".into(), json!({}))),
        "rpc" => {
            ensure!(
                args.len() == 3,
                "Usage: stokd-agent rpc <method> <JSON parameters>"
            );
            Ok((arg(1).into(), serde_json::from_str(arg(2))?))
        }
        "import-poc" => {
            ensure!(args.len() == 1, "Usage: stokd-agent import-poc");
            Ok(("legacy.export".into(), json!({})))
        }
        "command" => {
            ensure!(
                args.len() >= 3,
                "Usage: stokd-agent command <name> <command> [arguments]"
            );
            Ok((
                "route.slash".into(),
                json!({"agent":arg(1),"line":format!("/{}",args[2..].join(" "))}),
            ))
        }
        other => bail!("Unsupported command: {other}"),
    }
}
