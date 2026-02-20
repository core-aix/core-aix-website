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
