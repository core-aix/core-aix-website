#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parent.parent
BLOG_DIR = ROOT / "content" / "blog"
OUTPUT_DIR = ROOT / "static" / "audio" / "blog"
API_URL = "https://api.openai.com/v1/audio/speech"


def parse_front_matter_and_body(raw: str) -> tuple[str, str]:
    if not raw.startswith("---\n"):
        return "", raw

    parts = raw.split("\n---\n", 1)
    if len(parts) != 2:
        return "", raw

    front_matter = parts[0].replace("---\n", "", 1)
    body = parts[1]
    return front_matter, body


def parse_title(front_matter: str, fallback: str) -> str:
    match = re.search(r'^title:\s*["\']?(.*?)["\']?\s*$', front_matter, re.MULTILINE)
    if match and match.group(1).strip():
        return match.group(1).strip()
    return fallback


def markdown_to_plain_text(markdown: str) -> str:
    text = markdown
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"!\[[^\]]*\]\([^\)]*\)", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^\)]*\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = re.sub(r"\*(.*?)\*", r"\1", text)
    text = re.sub(r"_([^_]+)_", r"\1", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def build_narration_text(title: str, body_markdown: str) -> str:
    body = markdown_to_plain_text(body_markdown)
    return f"{title}. {body}".strip()


def synthesize_mp3(
    api_key: str, model: str, voice: str, instructions: str, text: str
) -> bytes:
    payload = {
        "model": model,
        "voice": voice,
        "input": text,
        "format": "mp3",
    }
    if instructions:
        payload["instructions"] = instructions

    request = Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=120) as response:
            return response.read()
    except HTTPError as err:
        detail = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {err.code}: {detail}") from err
    except URLError as err:
        raise RuntimeError(f"Network error: {err.reason}") from err


def generate(force: bool, dry_run: bool) -> int:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    model = (
        os.getenv("OPENAI_TTS_MODEL", "gpt-4o-mini-tts").strip() or "gpt-4o-mini-tts"
    )
    voice = os.getenv("OPENAI_TTS_VOICE", "alloy").strip() or "alloy"
    instructions = os.getenv(
        "OPENAI_TTS_INSTRUCTIONS",
        "Narrate naturally and clearly in a warm, podcast style with measured pacing.",
    ).strip()

    posts = sorted(p for p in BLOG_DIR.glob("*.md") if p.name != "_index.md")
    if not posts:
        print("No blog markdown files found in content/blog.")
        return 0

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    if not api_key and not dry_run:
        print("Missing OPENAI_API_KEY. Set it and rerun.", file=sys.stderr)
        return 1

    failures = 0

    for post in posts:
        slug = post.stem
        output_file = OUTPUT_DIR / f"{slug}.mp3"

        if output_file.exists() and not force:
            print(
                f"Skipping {slug}: {output_file} already exists (use --force to regenerate)."
            )
            continue

        raw = post.read_text(encoding="utf-8")
        front_matter, body = parse_front_matter_and_body(raw)
        title = parse_title(front_matter, slug.replace("-", " ").title())
        narration = build_narration_text(title, body)

        if dry_run:
            print(f"[dry-run] Would generate: {output_file}")
            continue

        try:
            audio = synthesize_mp3(api_key, model, voice, instructions, narration)
            output_file.write_bytes(audio)
            print(f"Generated {output_file}")
        except RuntimeError as err:
            failures += 1
            print(f"Failed {slug}: {err}", file=sys.stderr)

    return 1 if failures else 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Generate one podcast MP3 per blog post."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Regenerate files even if they already exist.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be generated without API calls.",
    )
    args = parser.parse_args()
    return generate(force=args.force, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
