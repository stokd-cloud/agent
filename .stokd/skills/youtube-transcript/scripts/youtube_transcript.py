#!/usr/bin/env python3
"""Fetch a YouTube transcript into .stokd/artifacts/transcripts/youtube/."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path
from typing import Any, Optional


GENERIC_PLAYLISTS = {
    "uploads",
    "videos",
    "liked videos",
    "watch later",
    "favorites",
    "popular videos",
    "live",
    "streams",
}
SHOW_WORDS = ("podcast", "show", "radio", "hour", "interview series")
EPISODE_RE = re.compile(r"\b(?:episode|ep\.?)\s*(\d{1,4})\b", re.I)
HASH_EP_RE = re.compile(r"^\s*#\s*(\d{1,4})\b")
YOUTUBE_ID_RE = re.compile(
    r"(?:youtu\.be/|youtube\.com/(?:watch\?.*?v=|embed/|shorts/|live/)|"
    r"youtube\.com/shorts/)([A-Za-z0-9_-]{11})"
)
BARE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
NAME_RE = re.compile(r"^[A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3}$")
PAREN_RE = re.compile(r"\([^)]*\)")
TAG_RE = re.compile(r"<[^>]+>")
VTT_TS_RE = re.compile(
    r"^(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*"
    r"(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})"
)
ARTIFACT_REL = Path(".stokd") / "artifacts" / "transcripts" / "youtube"


def die(message: str, code: int = 1) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(code)


def slugify(text: str) -> str:
    value = unicodedata.normalize("NFKD", text or "")
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower().replace("'", "").replace("’", "")
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def truncate_slug(slug: str, limit: int) -> str:
    if len(slug) <= limit:
        return slug
    clipped = slug[:limit].rstrip("-")
    if "-" in clipped:
        clipped = clipped.rsplit("-", 1)[0]
    return clipped or slug[:limit]


def extract_video_id(raw: str) -> Optional[str]:
    text = (raw or "").strip()
    match = YOUTUBE_ID_RE.search(text)
    if match:
        return match.group(1)
    if BARE_ID_RE.fullmatch(text):
        return text
    return None


def canonical_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def looks_like_show(name: str) -> bool:
    lowered = name.lower()
    return any(word in lowered for word in SHOW_WORDS)


def split_title_parts(title: str) -> list[str]:
    chunks: list[str] = []
    for part in re.split(r"\s*[|•·]\s*", title or ""):
        chunks.extend(re.split(r"\s+[—–-]\s+", part))
    return [chunk.strip(" -–—,") for chunk in chunks if chunk.strip(" -–—,")]


def series_name(meta: dict[str, Any]) -> Optional[str]:
    series = meta.get("series")
    if isinstance(series, str) and series.strip():
        return series.strip()
    playlist = meta.get("playlist_title") or meta.get("playlist")
    if isinstance(playlist, str):
        cleaned = playlist.strip()
        if cleaned and cleaned.lower() not in GENERIC_PLAYLISTS:
            return cleaned
    channel = str(meta.get("channel") or meta.get("uploader") or "").strip()
    parts = split_title_parts(str(meta.get("title") or ""))
    if len(parts) >= 2:
        last = parts[-1]
        if looks_like_show(last) or (channel and slugify(last) == slugify(channel)):
            return last
    if channel and looks_like_show(channel):
        return channel
    return None


def episode_number(meta: dict[str, Any]) -> Optional[int]:
    for key in ("episode_number", "episode"):
        value = meta.get(key)
        if isinstance(value, int) and 1 <= value <= 9999:
            return value
        if isinstance(value, str) and value.strip().isdigit():
            number = int(value.strip())
            if 1 <= number <= 9999:
                return number
    title = str(meta.get("title") or "")
    for pattern in (EPISODE_RE, HASH_EP_RE):
        match = pattern.search(title)
        if match:
            return int(match.group(1))
    description = str(meta.get("description") or "")
    head = "\n".join(description.splitlines()[:12])
    match = EPISODE_RE.search(head)
    if match:
        return int(match.group(1))
    return None


def upload_date(meta: dict[str, Any]) -> Optional[str]:
    raw = meta.get("upload_date")
    if isinstance(raw, str) and len(raw) == 8 and raw.isdigit():
        return f"{raw[:4]}-{raw[4:6]}-{raw[6:8]}"
    return None


def guest_or_topic(meta: dict[str, Any], series: Optional[str]) -> str:
    title = str(meta.get("title") or "")
    parts = split_title_parts(title)
    series_slug = slugify(series or "")
    channel_slug = slugify(str(meta.get("channel") or meta.get("uploader") or ""))
    filtered = [
        part
        for part in parts
        if slugify(part) not in {series_slug, channel_slug}
        and slugify(PAREN_RE.sub("", part)) not in {series_slug, channel_slug}
    ]
    for part in reversed(filtered):
        with_match = re.search(
            r"\bwith\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3})\b", part
        )
        if with_match:
            return slugify(with_match.group(1))
        candidate = PAREN_RE.sub("", part).strip()
        if NAME_RE.match(candidate):
            return slugify(candidate)
    if filtered:
        return truncate_slug(slugify(PAREN_RE.sub("", filtered[0])), 40)
    return truncate_slug(slugify(PAREN_RE.sub("", title)), 40)


def format_episode(number: int) -> str:
    return f"ep-{number:02d}" if number < 100 else f"ep-{number}"


def build_slug(meta: dict[str, Any]) -> str:
    series = series_name(meta)
    channel = str(meta.get("channel") or meta.get("uploader") or "youtube")
    head = slugify(series or channel) or "youtube"
    tail = guest_or_topic(meta, series)
    if tail.startswith(head + "-"):
        tail = tail[len(head) + 1 :]
    if tail == head:
        tail = ""
    if series:
        episode = episode_number(meta)
        mid = format_episode(episode) if episode is not None else (upload_date(meta) or "undated")
        parts = [head, mid]
        if tail:
            parts.append(tail)
        slug = "-".join(parts)
    else:
        slug = f"{head}-{tail}" if tail else head
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return truncate_slug(slug, 80)


MISSING_YT_DLP = """yt-dlp is required and was not found on PATH.

This skill uses yt-dlp to search YouTube and download captions. Install it,
then retry:

  macOS (Homebrew):  brew install yt-dlp
  pip:               python3 -m pip install -U yt-dlp
  docs/releases:     https://github.com/yt-dlp/yt-dlp#installation
"""


def which_yt_dlp() -> str:
    path = shutil.which("yt-dlp")
    if not path:
        die(MISSING_YT_DLP)
    return path


def run_yt_dlp(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    binary = which_yt_dlp()
    completed = subprocess.run(
        [binary, *args],
        text=True,
        capture_output=True,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "yt-dlp failed").strip()
        die(detail)
    return completed


def parse_json_lines(raw: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    text = raw.strip()
    if not text:
        return rows
    try:
        loaded = json.loads(text)
        if isinstance(loaded, dict):
            return [loaded]
        if isinstance(loaded, list):
            return [row for row in loaded if isinstance(row, dict)]
    except json.JSONDecodeError:
        pass
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        rows.append(json.loads(line))
    return rows


def cmd_search(query: str, maximum: int) -> None:
    maximum = max(1, min(maximum, 10))
    completed = run_yt_dlp(
        [
            "--flat-playlist",
            "--dump-json",
            "--no-warnings",
            f"ytsearch{maximum}:{query}",
        ]
    )
    results = []
    for row in parse_json_lines(completed.stdout):
        video_id = str(row.get("id") or "")
        if not video_id:
            continue
        results.append(
            {
                "video_id": video_id,
                "url": canonical_url(video_id),
                "title": row.get("title"),
                "channel": row.get("channel") or row.get("uploader"),
                "duration": row.get("duration"),
                "upload_date": upload_date(row),
            }
        )
    print(json.dumps({"ok": True, "query": query, "results": results}, indent=2))


def load_meta(url: str) -> dict[str, Any]:
    video_id = extract_video_id(url)
    target = canonical_url(video_id) if video_id else url
    completed = run_yt_dlp(
        ["--skip-download", "--no-playlist", "--dump-json", "--no-warnings", target]
    )
    rows = parse_json_lines(completed.stdout)
    if not rows:
        die("yt-dlp returned no metadata")
    meta = rows[0]
    resolved_id = str(meta.get("id") or video_id or "")
    if not resolved_id:
        die("could not resolve a YouTube video id")
    meta["_resolved_id"] = resolved_id
    meta["_canonical_url"] = canonical_url(resolved_id)
    meta["_slug"] = build_slug(meta)
    return meta


def public_meta(meta: dict[str, Any]) -> dict[str, Any]:
    duration = meta.get("duration")
    return {
        "ok": True,
        "video_id": meta["_resolved_id"],
        "url": meta["_canonical_url"],
        "title": meta.get("title"),
        "channel": meta.get("channel") or meta.get("uploader"),
        "series": series_name(meta),
        "episode": episode_number(meta),
        "upload_date": upload_date(meta),
        "duration_seconds": duration if isinstance(duration, (int, float)) else None,
        "slug": meta["_slug"],
    }


def vtt_timestamp_to_seconds(match: re.Match[str]) -> float:
    hours = int(match.group(1) or match.group(5) or 0)
    minutes = int(match.group(2))
    seconds = int(match.group(3))
    millis = int(match.group(4))
    return hours * 3600 + minutes * 60 + seconds + millis / 1000


def parse_vtt(text: str) -> list[tuple[float, str]]:
    cues: list[tuple[float, str]] = []
    lines = text.replace("\ufeff", "").splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        match = VTT_TS_RE.match(line)
        if not match:
            index += 1
            continue
        start = vtt_timestamp_to_seconds(match)
        index += 1
        body: list[str] = []
        while index < len(lines) and lines[index].strip():
            piece = TAG_RE.sub("", lines[index]).strip()
            piece = piece.replace("&nbsp;", " ").replace("&amp;", "&")
            piece = piece.replace("&lt;", "<").replace("&gt;", ">")
            if piece and piece.upper() != "WEBVTT":
                body.append(piece)
            index += 1
        joined = re.sub(r"\s+", " ", " ".join(body)).strip()
        if joined:
            cues.append((start, joined))
    return merge_rolling_cues(cues)


def merge_rolling_cues(cues: list[tuple[float, str]]) -> list[tuple[float, str]]:
    merged: list[tuple[float, str]] = []
    for start, text in cues:
        if not merged:
            merged.append((start, text))
            continue
        prev_start, prev_text = merged[-1]
        if text == prev_text or text in prev_text:
            continue
        if prev_text in text and (text.startswith(prev_text) or text.endswith(prev_text)):
            merged[-1] = (prev_start, text)
            continue
        merged.append((start, text))
    return merged


def format_clock(seconds: float) -> str:
    total = int(seconds)
    hours, rem = divmod(total, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours:d}:{minutes:02d}:{secs:02d}"
    return f"{minutes:d}:{secs:02d}"


def cues_to_transcript(cues: list[tuple[float, str]]) -> str:
    if not cues:
        return ""
    paragraphs: list[str] = []
    current: list[str] = []
    para_start = cues[0][0]
    last_end = cues[0][0]
    for start, text in cues:
        if current and start - last_end > 1.8:
            paragraphs.append(f"[{format_clock(para_start)}] {' '.join(current)}")
            current = [text]
            para_start = start
        else:
            current.append(text)
        last_end = start
    if current:
        paragraphs.append(f"[{format_clock(para_start)}] {' '.join(current)}")
    return "\n\n".join(paragraphs)


def download_captions(url: str, video_id: str) -> tuple[str, str]:
    with tempfile.TemporaryDirectory(prefix="yt-transcript-") as tmp:
        tmpdir = Path(tmp)
        official = run_yt_dlp(
            [
                "--skip-download",
                "--no-playlist",
                "--write-subs",
                "--sub-langs",
                "en.*,en",
                "--sub-format",
                "vtt",
                "--no-warnings",
                "-o",
                str(tmpdir / "%(id)s"),
                url,
            ],
            check=False,
        )
        kind = "official"
        vtts = list(tmpdir.glob("*.vtt"))
        if not vtts:
            auto = run_yt_dlp(
                [
                    "--skip-download",
                    "--no-playlist",
                    "--write-auto-subs",
                    "--sub-langs",
                    "en.*,en",
                    "--sub-format",
                    "vtt",
                    "--no-warnings",
                    "-o",
                    str(tmpdir / "%(id)s"),
                    url,
                ],
                check=False,
            )
            kind = "auto"
            vtts = list(tmpdir.glob("*.vtt"))
            if not vtts:
                detail = (auto.stderr or official.stderr or "no captions").strip()
                die(f"no English captions available for {video_id}: {detail}")
        # Prefer non-auto filenames when both exist.
        vtts.sort(key=lambda path: ("auto" in path.name.lower(), len(path.name)))
        text = vtts[0].read_text(encoding="utf-8", errors="replace")
        return kind, text


def yaml_quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def render_markdown(meta: dict[str, Any], captions: str, transcript: str, slug: str) -> str:
    title = str(meta.get("title") or slug)
    channel = str(meta.get("channel") or meta.get("uploader") or "")
    series = series_name(meta) or ""
    episode = episode_number(meta)
    date = upload_date(meta) or ""
    duration = meta.get("duration")
    duration_s = int(duration) if isinstance(duration, (int, float)) else ""
    lines = [
        "---",
        "source: youtube",
        f"url: {meta['_canonical_url']}",
        f"video_id: {meta['_resolved_id']}",
        f"title: {yaml_quote(title)}",
        f"channel: {yaml_quote(channel)}",
        f"series: {yaml_quote(series)}" if series else "series: null",
        f"episode: {episode}" if episode is not None else "episode: null",
        f"upload_date: {date}" if date else "upload_date: null",
        f"duration_seconds: {duration_s}" if duration_s != "" else "duration_seconds: null",
        f"captions: {captions}",
        f"slug: {slug}",
        "---",
        "",
        f"# {title}",
        "",
    ]
    bits = [bit for bit in (channel, date, f"{duration_s}s" if duration_s != "" else "") if bit]
    if bits:
        lines.append(" · ".join(bits))
        lines.append("")
    lines.extend(["## Transcript", "", transcript.rstrip(), ""])
    return "\n".join(lines)


def resolve_workspace(explicit: Optional[str]) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    completed = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        text=True,
        capture_output=True,
    )
    if completed.returncode == 0 and completed.stdout.strip():
        return Path(completed.stdout.strip()).resolve()
    return Path.cwd().resolve()


def existing_video_id(path: Path) -> Optional[str]:
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[:40]:
        if line.startswith("video_id:"):
            return line.split(":", 1)[1].strip().strip('"')
    return None


def cmd_fetch(url: str, workspace: Optional[str], slug_override: Optional[str]) -> None:
    meta = load_meta(url)
    slug = slugify(slug_override) if slug_override else meta["_slug"]
    if not slug:
        die("slug is empty")
    root = resolve_workspace(workspace)
    dest_dir = root / ARTIFACT_REL
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"{slug}.md"
    prior = existing_video_id(dest)
    if prior and prior != meta["_resolved_id"]:
        die(
            f"{dest} already holds video {prior}; pass --slug to write a different filename"
        )
    kind, vtt = download_captions(meta["_canonical_url"], meta["_resolved_id"])
    transcript = cues_to_transcript(parse_vtt(vtt))
    if not transcript.strip():
        die("captions downloaded but transcript text was empty")
    dest.write_text(render_markdown(meta, kind, transcript, slug), encoding="utf-8")
    payload = public_meta(meta)
    payload.update(
        {
            "slug": slug,
            "captions": kind,
            "path": str(dest),
            "relative_path": str(ARTIFACT_REL / f"{slug}.md"),
        }
    )
    print(json.dumps(payload, indent=2))


def cmd_meta(url: str) -> None:
    print(json.dumps(public_meta(load_meta(url)), indent=2))


def self_test() -> None:
    assert slugify("Lenny's Podcast") == "lennys-podcast"
    series_meta = {
        "title": "How to set product strategy | Jen Abel (SVPG) | Lenny's Podcast",
        "channel": "Lenny's Podcast",
        "episode_number": 12,
        "upload_date": "20240315",
    }
    assert build_slug(series_meta) == "lennys-podcast-ep-12-jen-abel", build_slug(series_meta)
    dated = {
        "title": "How to set product strategy | Jen Abel (SVPG) | Lenny's Podcast",
        "channel": "Lenny's Podcast",
        "upload_date": "20240315",
    }
    assert build_slug(dated) == "lennys-podcast-2024-03-15-jen-abel", build_slug(dated)
    standalone = {
        "title": "The best on YouTube",
        "channel": "Veritasium",
        "upload_date": "20240101",
    }
    assert build_slug(standalone) == "veritasium-the-best-on-youtube", build_slug(standalone)
    vtt = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:02.000\nHello world\n\n"
        "00:00:01.500 --> 00:00:03.500\nHello world this\n\n"
        "00:00:05.000 --> 00:00:06.000\nNew paragraph\n"
    )
    cues = parse_vtt(vtt)
    assert cues[0][1] == "Hello world this", cues
    text = cues_to_transcript(cues)
    assert "Hello world this" in text and "New paragraph" in text
    assert extract_video_id("https://youtu.be/dQw4w9WgXcQ") == "dQw4w9WgXcQ"
    assert "brew install yt-dlp" in MISSING_YT_DLP
    assert "https://github.com/yt-dlp/yt-dlp#installation" in MISSING_YT_DLP
    print(json.dumps({"ok": True, "self_test": "passed"}))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    search = sub.add_parser("search", help="Search YouTube via yt-dlp")
    search.add_argument("--query", required=True)
    search.add_argument("--max", type=int, default=5)

    meta = sub.add_parser("meta", help="Print resolved identity and proposed slug")
    meta.add_argument("--url", required=True)

    fetch = sub.add_parser("fetch", help="Write the transcript artifact")
    fetch.add_argument("--url", required=True)
    fetch.add_argument("--workspace")
    fetch.add_argument("--slug")

    sub.add_parser("self-test", help="Run slug and caption parser checks")
    return parser


def main(argv: Optional[list[str]] = None) -> None:
    args = build_parser().parse_args(argv)
    if args.command == "search":
        cmd_search(args.query, args.max)
    elif args.command == "meta":
        cmd_meta(args.url)
    elif args.command == "fetch":
        cmd_fetch(args.url, args.workspace, args.slug)
    elif args.command == "self-test":
        self_test()
    else:
        die(f"unknown command {args.command}")


if __name__ == "__main__":
    main()
