#!/usr/bin/env python3
"""Read-only audit of canonical Stokd skills and provider-native copies."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


SKILL_FILE = "SKILL.md"
IGNORED_PARTS = {"__pycache__", ".DS_Store"}
GENERATED_RELATIVE_PATHS = {"agents/openai.yaml"}
PROVIDER_PATH_RE = re.compile(
    r"(?:~|/Users/[^/\s]+|/home/[^/\s]+)/\.(claude|codex|grok|gemini|devin|factory|amp)(?:/|\b)",
    re.IGNORECASE,
)
PROVIDER_RELATIVE_PATH_RE = re.compile(
    r"(?:^|[\s`'\"(])\.(claude|codex|grok|gemini|devin|factory|amp)/(?:skills|commands|prompts)(?:/|\b)",
    re.IGNORECASE | re.MULTILINE,
)
PROVIDER_COMMAND_RE = re.compile(
    r"(?:^|[\s`'\"(])(claude|codex|grok|gemini|devin|droid|amp)\s+(?:--[A-Za-z]|resume\b)",
    re.IGNORECASE | re.MULTILINE,
)
PROVIDER_TOOL_RE = re.compile(
    r"(?:subagent_type\s*[:=]\s*[\"']general-purpose|\bTask\(|\btask tool\b)",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Copy:
    name: str
    scope: str
    path: str
    invocation_policy: str
    skill_sha256: str
    portable_bundle_sha256: str
    provider_assumptions: tuple[str, ...]


@dataclass(frozen=True)
class Finding:
    severity: str
    code: str
    skill: str
    path: str
    detail: str


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def portable_files(skill_dir: Path) -> Iterable[Path]:
    for path in sorted(skill_dir.rglob("*")):
        if (
            path.is_symlink()
            or not path.is_file()
            or any(part in IGNORED_PARTS for part in path.parts)
        ):
            continue
        rel = path.relative_to(skill_dir).as_posix()
        if rel in GENERATED_RELATIVE_PATHS:
            continue
        yield path


def portable_skill_bytes(data: bytes) -> bytes:
    """Remove provider-adapted frontmatter while preserving the skill body."""
    text = data.decode("utf-8", errors="replace")
    lines = text.splitlines(keepends=True)
    if not lines or lines[0].strip() != "---":
        return data
    for index, line in enumerate(lines[1:], 1):
        if line.strip() == "---":
            return "".join(lines[index + 1 :]).encode("utf-8")
    return data


def bundle_digest(skill_dir: Path) -> str:
    digest = hashlib.sha256()
    for path in portable_files(skill_dir):
        rel = path.relative_to(skill_dir).as_posix().encode("utf-8")
        digest.update(len(rel).to_bytes(8, "big"))
        digest.update(rel)
        data = path.read_bytes()
        if rel.decode("utf-8") == SKILL_FILE:
            data = portable_skill_bytes(data)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()


def frontmatter(text: str) -> dict[str, str]:
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    values: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*?)\s*$", line)
        if match:
            values[match.group(1).lower()] = match.group(2).strip("'\"")
    return values


def invocation_policy(meta: dict[str, str]) -> str:
    explicit = meta.get("invocation", "").lower()
    if explicit in {"auto", "explicit", "disabled"}:
        return explicit
    disabled = meta.get("disable-model-invocation", "").lower()
    if disabled == "true":
        return "explicit"
    return "auto"


def assumptions(text: str) -> tuple[str, ...]:
    found = {f"provider-path:{match.lower()}" for match in PROVIDER_PATH_RE.findall(text)}
    found.update(
        f"provider-path:{match.lower()}" for match in PROVIDER_RELATIVE_PATH_RE.findall(text)
    )
    found.update(
        f"provider-command:{match.lower()}" for match in PROVIDER_COMMAND_RE.findall(text)
    )
    if PROVIDER_TOOL_RE.search(text):
        found.add("provider-tool-assumption")
    return tuple(sorted(found))


def discover(root: Path, scope: str) -> list[Copy]:
    if not root.is_dir():
        return []
    copies: list[Copy] = []
    for skill_dir in sorted(root.iterdir()):
        skill_file = skill_dir / SKILL_FILE
        if (
            skill_dir.is_symlink()
            or not skill_dir.is_dir()
            or skill_file.is_symlink()
            or not skill_file.is_file()
        ):
            continue
        data = skill_file.read_bytes()
        text = data.decode("utf-8", errors="replace")
        meta = frontmatter(text)
        name = meta.get("name") or skill_dir.name
        copies.append(
            Copy(
                name=name,
                scope=scope,
                path=str(skill_dir),
                invocation_policy=invocation_policy(meta),
                skill_sha256=sha256_bytes(data),
                portable_bundle_sha256=bundle_digest(skill_dir),
                provider_assumptions=assumptions(text),
            )
        )
    return copies


def default_provider_roots(workspace: Path, home: Path) -> list[tuple[str, Path]]:
    del workspace  # workspace skills are canonical, not generated provider roots
    return [
        (f"global-{name}", home / f".{name}" / "skills")
        for name in ("claude", "codex", "grok", "gemini", "devin", "factory", "amp")
    ]


def parse_provider_root(raw: str) -> tuple[str, Path]:
    if "=" not in raw:
        raise argparse.ArgumentTypeError("provider root must be LABEL=PATH")
    label, path = raw.split("=", 1)
    if not label.strip() or not path.strip():
        raise argparse.ArgumentTypeError("provider root must be LABEL=PATH")
    return label.strip(), Path(path).expanduser().resolve()


def audit(
    workspace: Path,
    home: Path,
    provider_roots: list[tuple[str, Path]],
) -> dict:
    canonical = discover(workspace / ".stokd" / "skills", "workspace")
    global_canonical = discover(home / ".stokd" / "skills", "global")
    winners: dict[str, Copy] = {copy.name: copy for copy in global_canonical}
    winners.update({copy.name: copy for copy in canonical})

    provider_copies: list[Copy] = []
    roots_that_exist: list[str] = []
    for label, root in provider_roots:
        if root.is_dir():
            roots_that_exist.append(label)
        provider_copies.extend(discover(root, f"provider:{label}"))

    by_name: dict[str, list[Copy]] = {}
    for copy in provider_copies:
        by_name.setdefault(copy.name, []).append(copy)

    findings: list[Finding] = []
    for name, winner in sorted(winners.items()):
        copies = by_name.get(name, [])
        seen_scopes = {copy.scope.removeprefix("provider:") for copy in copies}
        for copy in copies:
            if winner.invocation_policy == "disabled":
                findings.append(
                    Finding(
                        "high",
                        "disabled-copy-present",
                        name,
                        copy.path,
                        "canonical policy is disabled but a native copy still exists",
                    )
                )
            if copy.portable_bundle_sha256 != winner.portable_bundle_sha256:
                findings.append(
                    Finding(
                        "high",
                        "digest-drift",
                        name,
                        copy.path,
                        f"provider digest differs from canonical {winner.portable_bundle_sha256}",
                    )
                )
        for label in roots_that_exist:
            if label not in seen_scopes:
                findings.append(
                    Finding(
                        "low",
                        "missing-provider-copy",
                        name,
                        str(dict(provider_roots)[label] / name),
                        "provider root exists but this canonical skill has no copy",
                    )
                )
        for assumption in winner.provider_assumptions:
            findings.append(
                Finding(
                    "medium",
                    "provider-specific-assumption",
                    name,
                    winner.path,
                    assumption,
                )
            )

    for name, copies in sorted(by_name.items()):
        if name in winners:
            continue
        for copy in copies:
            findings.append(
                Finding(
                    "medium",
                    "unmanaged-provider-only",
                    name,
                    copy.path,
                    "native provider skill has no workspace or global Stokd canonical source",
                )
            )

    skill_rows = []
    for name, winner in sorted(winners.items()):
        skill_rows.append(
            {
                "name": name,
                "canonical": asdict(winner),
                "provider_copies": [asdict(copy) for copy in by_name.get(name, [])],
            }
        )

    counts: dict[str, int] = {}
    for finding in findings:
        counts[finding.code] = counts.get(finding.code, 0) + 1
    return {
        "summary": {
            "canonical_skills": len(winners),
            "provider_copies": len(provider_copies),
            "findings": len(findings),
            "by_code": counts,
        },
        "skills": skill_rows,
        "findings": [asdict(finding) for finding in findings],
    }


def render_text(report: dict) -> str:
    summary = report["summary"]
    lines = [
        f"canonical skills: {summary['canonical_skills']}",
        f"provider copies: {summary['provider_copies']}",
        f"findings: {summary['findings']}",
    ]
    for finding in report["findings"]:
        lines.append(
            f"{finding['severity'].upper()} {finding['code']} "
            f"{finding['skill']} {finding['path']}: {finding['detail']}"
        )
    return "\n".join(lines)


def self_test() -> None:
    with tempfile.TemporaryDirectory(prefix="stokd-skill-audit-") as raw:
        root = Path(raw)
        workspace = root / "workspace"
        home = root / "home"
        provider = root / "provider"

        def write(base: Path, name: str, body: str) -> None:
            directory = base / name
            directory.mkdir(parents=True, exist_ok=True)
            (directory / SKILL_FILE).write_text(body, encoding="utf-8")

        good = "---\nname: good\ndescription: Good skill.\n---\n\n# Good\n"
        disabled = (
            "---\nname: disabled\ndescription: Disabled skill.\n"
            "invocation: disabled\n---\n\n# Disabled\n"
        )
        write(workspace / ".stokd" / "skills", "good", good)
        write(workspace / ".stokd" / "skills", "disabled", disabled)
        write(
            workspace / ".stokd" / "skills",
            "specific",
            "---\nname: specific\ndescription: Specific.\n---\n\nRun `claude --resume x`.\n",
        )
        write(provider, "good", good.replace("# Good", "# Drift"))
        write(provider, "disabled", disabled)
        write(
            provider,
            "specific",
            "---\nname: specific\ndescription: Specific.\n---\n\nRun `claude --resume x`.\n",
        )
        write(provider, "native", "---\nname: native\ndescription: Native.\n---\n")

        before = sorted((str(path.relative_to(root)), path.read_bytes()) for path in root.rglob("*") if path.is_file())
        report = audit(workspace, home, [("fixture", provider)])
        after = sorted((str(path.relative_to(root)), path.read_bytes()) for path in root.rglob("*") if path.is_file())
        codes = {finding["code"] for finding in report["findings"]}
        required = {
            "digest-drift",
            "disabled-copy-present",
            "provider-specific-assumption",
            "unmanaged-provider-only",
        }
        if not required.issubset(codes):
            raise AssertionError(f"missing findings: {sorted(required - codes)}")
        if before != after:
            raise AssertionError("audit changed fixture files")
    print("skill-audit self-test: PASS")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd())
    parser.add_argument("--home", type=Path, default=Path.home())
    parser.add_argument("--provider-root", action="append", default=[], type=parse_provider_root)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    workspace = args.workspace.expanduser().resolve()
    home = args.home.expanduser().resolve()
    roots = args.provider_root or default_provider_roots(workspace, home)
    report = audit(workspace, home, roots)
    if args.json:
        json.dump(report, sys.stdout, indent=2, sort_keys=True)
        sys.stdout.write("\n")
    else:
        print(render_text(report))
    actionable = any(
        finding["severity"] in {"high", "medium"} for finding in report["findings"]
    )
    return 2 if args.strict and actionable else 0


if __name__ == "__main__":
    raise SystemExit(main())
