#!/usr/bin/env python3
"""Group ranked Stokd sessions into batched cmux workspaces."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional


RELATIVE_RE = re.compile(r"^\s*(\d+)\s*([smhdw])\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class Session:
    provider: str
    session_id: str
    score: float
    title: str
    cwd: Optional[str]
    started_at: Optional[datetime]
    last_at: Optional[datetime]
    prompt_count: int
    first_prompt: str
    source_path: str

    @property
    def updated(self) -> Optional[datetime]:
        return self.last_at or self.started_at


def parse_relative(raw: str) -> timedelta:
    match = RELATIVE_RE.match(raw or "48h")
    if not match:
        raise SystemExit(f"invalid relative time {raw!r}; use 24h, 48h, 7d, or 1w")
    amount = int(match.group(1))
    multiplier = {"s": 1, "m": 60, "h": 3600, "d": 86_400, "w": 604_800}[
        match.group(2).lower()
    ]
    return timedelta(seconds=amount * multiplier)


def parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def binary(name: str) -> str:
    return shutil.which(name) or name


def git_root() -> Optional[Path]:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
        return None
    return Path(result.stdout.strip()).resolve()


def load_payload(target: str, limit: int, input_json: Optional[Path]) -> dict:
    if input_json is not None:
        with input_json.open("r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if not isinstance(payload, dict):
            raise SystemExit("input JSON must be an object")
        return payload

    command = [
        binary("stokd"),
        "session",
        "find",
        target,
        "--limit",
        str(limit),
        "--json",
        "--no-live",
    ]
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()
        raise SystemExit(f"stokd session find failed ({result.returncode}): {detail}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit(f"stokd session find returned invalid JSON: {error}") from error
    if not isinstance(payload, dict):
        raise SystemExit("stokd session find JSON must be an object")
    return payload


def session_from_row(row: dict) -> Optional[Session]:
    provider = str(row.get("provider") or "").strip()
    session_id = str(row.get("session_id") or "").strip()
    if not provider or not session_id:
        return None
    cwd_value = row.get("cwd")
    cwd = str(cwd_value).strip() if cwd_value else None
    return Session(
        provider=provider,
        session_id=session_id,
        score=float(row.get("score") or 0.0),
        title=str(row.get("title") or ""),
        cwd=cwd,
        started_at=parse_datetime(row.get("started_at")),
        last_at=parse_datetime(row.get("last_at")),
        prompt_count=int(row.get("prompt_count") or 0),
        first_prompt=str(row.get("first_prompt") or ""),
        source_path=str(row.get("source_path") or ""),
    )


def source_mtime(session: Session) -> Optional[datetime]:
    if not session.source_path:
        return None
    try:
        stamp = Path(session.source_path).stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(stamp, tz=timezone.utc)


def select_sessions(payload: dict, cutoff: datetime, top: int) -> list[Session]:
    rows = payload.get("results")
    if not isinstance(rows, list):
        raise SystemExit("session-find JSON has no results array")
    selected: list[Session] = []
    seen: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        session = session_from_row(row)
        if session is None:
            continue
        key = (session.provider, session.session_id)
        if key in seen:
            continue
        updated = session.updated or source_mtime(session)
        if updated is None or updated < cutoff:
            continue
        seen.add(key)
        selected.append(session)
    selected.sort(key=lambda item: item.score, reverse=True)
    return selected[:top]


def rank_sessions(payload: dict, cutoff: datetime, top: int) -> list[Session]:
    """Compatibility-named entry point; ranking remains owned by Stokd."""
    return select_sessions(payload, cutoff, top)


def safe_cwd(session: Session, fallback: Path) -> Path:
    if session.cwd:
        candidate = Path(session.cwd).expanduser()
        if candidate.is_dir():
            return candidate.resolve()
    return fallback


def resume_argv(session: Session, fallback: Path) -> list[str]:
    return [
        binary("stokd"),
        "chat",
        "-C",
        str(safe_cwd(session, fallback)),
        "resume",
        session.session_id,
    ]


def resume_command(session: Session, fallback: Path) -> str:
    return shlex.join(resume_argv(session, fallback))


def terminal_surface(session: Session, fallback: Path) -> dict:
    title = session.title or session.first_prompt or session.session_id
    return {
        "type": "terminal",
        "name": f"{session.provider}:{session.session_id[:8]} {title[:38]}"[:60],
        "cwd": str(safe_cwd(session, fallback)),
        "command": resume_command(session, fallback),
        "env": {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")},
    }


def layout_for_sessions(batch: list[Session], fallback: Path) -> dict:
    panes = [{"pane": {"surfaces": [terminal_surface(session, fallback)]}} for session in batch]
    if len(panes) == 1:
        return panes[0]
    if len(panes) == 2:
        return {"direction": "horizontal", "split": 0.5, "children": panes}
    if len(panes) == 3:
        return {
            "direction": "horizontal",
            "split": 0.5,
            "children": [
                panes[0],
                {"direction": "vertical", "split": 0.5, "children": panes[1:]},
            ],
        }
    return {
        "direction": "horizontal",
        "split": 0.5,
        "children": [
            {"direction": "vertical", "split": 0.5, "children": panes[:2]},
            {"direction": "vertical", "split": 0.5, "children": panes[2:4]},
        ],
    }


def run_cmux(arguments: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [binary("cmux"), *arguments],
        text=True,
        capture_output=True,
        check=False,
    )


def cmux_available() -> bool:
    result = run_cmux(["ping"])
    return result.returncode == 0 and "PONG" in (result.stdout + result.stderr)


def parse_ref(output: str, prefix: str) -> Optional[str]:
    match = re.search(rf"{re.escape(prefix)}:\d+", output)
    if match:
        return match.group(0)
    try:
        payload = json.loads(output)
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict):
        for key in ("ref", "group_ref", "workspace_ref", "id"):
            if payload.get(key) is not None:
                return str(payload[key])
    return None


def create_group(name: str, cwd: Path) -> str:
    result = run_cmux(
        ["workspace-group", "create", "--name", name, "--cwd", str(cwd), "--json"]
    )
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        raise SystemExit(f"cmux workspace-group create failed: {output.strip()}")
    ref = parse_ref(output, "workspace_group")
    if ref is None:
        raise SystemExit(f"could not parse workspace-group reference: {output[:500]}")
    return ref


def create_workspace(
    name: str,
    description: str,
    cwd: Path,
    layout: dict,
    group: str,
    focus: bool,
) -> str:
    result = run_cmux(
        [
            "new-workspace",
            "--name",
            name,
            "--description",
            description,
            "--cwd",
            str(cwd),
            "--layout",
            json.dumps(layout, separators=(",", ":")),
            "--group",
            group,
            "--group-placement",
            "end",
            "--focus",
            "true" if focus else "false",
            "--json",
        ]
    )
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        raise SystemExit(f"cmux new-workspace failed: {output.strip()}")
    return parse_ref(output, "workspace") or output.strip() or "workspace:?"


def print_sessions(sessions: list[Session], fallback: Path) -> None:
    print(f"{'#':>2}  {'provider':10}  {'score':>8}  {'prompts':>7}  {'updated':16}  id  title")
    for index, session in enumerate(sessions, 1):
        updated = session.updated
        updated_text = updated.astimezone().strftime("%Y-%m-%d %H:%M") if updated else "unknown"
        title = session.title or session.first_prompt
        print(
            f"{index:>2}  {session.provider:10}  {session.score:>8.2f}  "
            f"{session.prompt_count:>7}  {updated_text:16}  "
            f"{session.session_id[:12]}  {title[:52]}"
        )
        print(f"    resume: {resume_command(session, fallback)}")


def self_test() -> None:
    now = datetime.now(timezone.utc)
    payload = {
        "results": [
            {
                "provider": "codex",
                "session_id": "codex-current",
                "score": 8.5,
                "title": "Current work",
                "cwd": str(Path.cwd()),
                "last_at": now.isoformat(),
                "prompt_count": 20,
            },
            {
                "provider": "gemini",
                "session_id": "gemini-current",
                "score": 7.0,
                "title": "Second work",
                "cwd": str(Path.cwd()),
                "last_at": now.isoformat(),
                "prompt_count": 10,
            },
            {
                "provider": "grok",
                "session_id": "old",
                "score": 99.0,
                "last_at": (now - timedelta(days=10)).isoformat(),
            },
        ]
    }
    sessions = select_sessions(payload, now - timedelta(hours=48), 4)
    if [session.provider for session in sessions] != ["codex", "gemini"]:
        raise AssertionError("cross-provider ranking or time filtering failed")
    command = resume_command(sessions[0], Path.cwd())
    if "stokd chat -C" not in command or "resume codex-current" not in command:
        raise AssertionError(f"non-portable resume command: {command}")
    layout = layout_for_sessions(sessions, Path.cwd())
    if len(layout.get("children", [])) != 2:
        raise AssertionError("two-session layout is not a two-pane split")
    with tempfile.TemporaryDirectory(prefix="session-group-") as raw:
        fixture = Path(raw) / "sessions.json"
        fixture.write_text(json.dumps(payload), encoding="utf-8")
        loaded = load_payload("ignored", 4, fixture)
        if loaded != payload:
            raise AssertionError("fixture JSON load changed payload")
    print("session-group self-test: PASS")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", "-t", required=False)
    parser.add_argument("--since", "-s", default="48h")
    parser.add_argument("--top", "-n", type=int, default=4)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--no-focus", action="store_true")
    parser.add_argument("--group-name")
    parser.add_argument("--input-json", type=Path, help=argparse.SUPPRESS)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args(argv)

    if args.self_test:
        self_test()
        return 0
    if not args.target:
        raise SystemExit("--target is required")
    if args.top < 1:
        raise SystemExit("--top must be at least one")

    cutoff = datetime.now(timezone.utc) - parse_relative(args.since)
    payload = load_payload(args.target, max(100, args.top * 10), args.input_json)
    sessions = rank_sessions(payload, cutoff, args.top)
    fallback = git_root() or Path.cwd().resolve()

    print(f"target={args.target!r} since={args.since} matched={len(sessions)}")
    if not sessions:
        print("No matching sessions in the requested time window.")
        return 1
    print_sessions(sessions, fallback)

    if args.dry_run:
        return 0
    if not cmux_available():
        print("cmux socket unreachable; use the resume commands above", file=sys.stderr)
        return 2

    group_name = (args.group_name or f"sessions:{args.target}@{args.since}")[:80]
    group = create_group(group_name, fallback)
    print(f"group={group} name={group_name!r}")
    workspaces: list[str] = []
    for offset in range(0, len(sessions), 4):
        batch = sessions[offset : offset + 4]
        workspace = create_workspace(
            name=f"{args.target} #{offset // 4 + 1}"[:60],
            description=", ".join(
                f"{session.provider}:{session.session_id[:8]}" for session in batch
            )[:120],
            cwd=fallback,
            layout=layout_for_sessions(batch, fallback),
            group=group,
            focus=offset == 0 and not args.no_focus,
        )
        workspaces.append(workspace)
        print(f"workspace={workspace} panes={len(batch)}")
    print(
        f"Opened {len(sessions)} session(s) across {len(workspaces)} "
        f"workspace(s) in {group}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
