# CORE-AIx Website (Hugo + Netlify)

This project is a Markdown-first Hugo website for the CORE-AIx lab.

## 1) Run locally

1. Install Hugo (extended recommended):
   - macOS (Homebrew): `brew install hugo`
2. Start the local server:
   - `hugo server -D`
3. Open:
   - `http://localhost:1313`

## 2) Create new posts quickly

- Blog: `hugo new blog/my-new-post.md`
- News: `hugo new news/my-news-item.md`

Each file uses archetypes with front matter, including an `author` field.

## 3) Author metadata

- Authors are defined in `data/authors.yaml`.
- In blog/news markdown, set front matter like:

```toml
author = "core-team"
```

The page automatically renders author name, role, and bio.

## 4) Deploy to Netlify

This repo includes `netlify.toml` with Hugo build settings.

On Netlify:

1. Create a new site from this repo.
2. Build command: `hugo --gc --minify`
3. Publish directory: `public`
4. Deploy.

Netlify will render all Markdown content through Hugo templates.

## 5) Generate podcast audio for blog posts

Each blog post can have a matching MP3 file at `static/audio/blog/<slug>.mp3`.

1. Set your API key:
   - `export OPENAI_API_KEY="<your-key>"`
2. (Optional) choose model/voice:
   - `export OPENAI_TTS_MODEL="gpt-4o-mini-tts"`
   - `export OPENAI_TTS_VOICE="alloy"`
3. Generate audio files:
   - `python3 scripts/generate_podcasts.py`

Useful flags:
- `python3 scripts/generate_podcasts.py --dry-run`
- `python3 scripts/generate_podcasts.py --force`

## 6) RSS feeds (blog, news, podcast)

When deployed at `https://core-aix.org/`, these feeds are available:

- Blog RSS: `https://core-aix.org/blog/index.xml`
- News RSS: `https://core-aix.org/news/index.xml`
- Podcast RSS (audio episodes from blog posts with MP3 files): `https://core-aix.org/blog/podcast.xml`

Podcast mapping rule:
- Blog file `content/blog/my-post.md` expects audio at `static/audio/blog/my-post.mp3`
- Only posts with matching MP3 files are included in `podcast.xml`

## 7) Publish to podcast platforms

1. Generate and upload episode MP3 files under `static/audio/blog/`.
2. Deploy the site so `https://core-aix.org/blog/podcast.xml` is public.
3. Validate your feed (recommended):
   - Cast Feed Validator: `https://castfeedvalidator.com/`
4. Submit to directories:
   - Spotify for Creators (RSS submission)
   - Apple Podcasts Connect (RSS submission)
   - YouTube Music (podcast RSS)

Tip: After approval, publishing a new episode is just adding a new blog post + matching MP3 file, then redeploying.
