---
name: youtube-transcript
description: >-
  Pull a YouTube transcript and write it to
  .stokd/artifacts/transcripts/youtube/<video-slug>.md. Use when the user
  runs /youtube-transcript, pastes a YouTube URL to transcribe, or names a
  video or podcast episode to save as a transcript.
---

# YouTube Transcript

Write captions from a real YouTube video into the current workspace. Never
invent a transcript.

## Procedure

1. Resolve the video.
   - Watch / Shorts / `youtu.be` / `/live/` URL: use that video.
   - Text reference: search, then pick one video.
   - Playlist URL with no video id, "latest episode", a show name with no
     guest/date/number, zero matches, or two or more plausible matches: ask
     qualifying questions (title, channel, guest, approximate date) or present
     numbered candidates. Do not fetch until identity is unique.
2. Resolve the script from the first existing path:
   - `$STOKD_SKILLS_DIR/youtube-transcript/scripts/youtube_transcript.py`
   - `~/.stokd/skills/youtube-transcript/scripts/youtube_transcript.py`
3. For a text reference:
   `python3 <script> search --query "<text>" --max 5`
4. Confirm identity:
   `python3 <script> meta --url <url>`
   Report title, channel, date, duration, and proposed slug. If that is not
   the intended video, stop and ask.
5. Write:
   `python3 <script> fetch --url <url> --workspace <repo-root>`
   Pass `--slug <slug>` only when the user overrides the filename.
6. Report the artifact path and slug. Do not claim captions exist if the
   script failed.

## Slugs

The script derives slugs. Do not hand-name files unless the user overrides.

- Series/show: `<series>-ep-<nn>-<guest-or-topic>.md` when an episode number
  is known, else `<series>-<yyyy-mm-dd>-<guest-or-topic>.md`.
  Example: `lennys-podcast-ep-12-jen-abel.md`.
- Standalone: `<channel>-<title>.md`.

Keep series prefixes stable so later episodes of the same show sort together
by filename.

## Rules

- Requires `yt-dlp` on PATH. Prefer official English captions, then
  auto-captions. Fail if neither exists.
- If `yt-dlp` is missing, stop and print the script error verbatim so the
  user sees the prerequisite and install options (Homebrew, pip, and
  https://github.com/yt-dlp/yt-dlp#installation). Do not fetch captions
  another way.
- Do not write a paraphrased or model-generated stand-in.
- Write only under `.stokd/artifacts/transcripts/youtube/` in the current
  workspace.
- Same video overwrites the same slug. A different video at that slug is an
  error; do not clobber.
- If yt-dlp reports sign-in or an age-gate, stop and tell the user. Do not
  guess another video.
