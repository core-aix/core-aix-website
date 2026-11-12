# The OpenReview Drafter

A page for writing OpenReview replies together, at
`https://core-aix.org/openreview-drafter/`. You write maths as in a paper, and
the page shows the reply exactly as OpenReview will render it. It also gives
the text to paste into OpenReview, with the extra backslashes that OpenReview
needs.

Anyone can use the page without an account, just to convert text. Signing in
with Google saves drafts and lets several people edit one draft at the same
time.

```
static/openreview-drafter/        the page (copied from the openreview-markdown repository)
  index.html, app.js, style.css
  escape.js                       LaTeX <-> OpenReview text conversion
  or-render.js                    OpenReview's own Markdown settings
  vendor/collab.js                CodeMirror, Yjs and the Liveblocks client, bundled
netlify/functions/drafts.mjs      sign-in, sharing and Liveblocks access
```

The page's source lives in the `openreview-markdown` repository. Edit it there
and run `npm run deploy`, which rebuilds `vendor/collab.js` and copies the files
here.

## How it works

- **Signing in.** The Google button gives the page an ID token. The function
  checks it with Google's public keys and answers with a session token of its
  own, valid for 30 days, which the page keeps in the browser. The first
  sign-in creates an account record in Netlify Blobs (store
  `openreview-drafter`, key `user/<email>`). The record holds the person's name
  and picture, which are shown in the sharing list.
- **Drafts.** Each draft is a Liveblocks room whose id starts with `ord-`.
  Liveblocks stores the text and merges everyone's edits live. It also stores
  the title and owner (room metadata) and who may open the draft (room users
  accesses), so there is only one sharing list.
- **Sharing.** Any member can add someone by e-mail address. The owner can
  remove anyone, and anyone can leave. Only the owner can delete a draft. The
  person added signs in with Google using that address and opens the link.
- **Saving.** There is no save button. The status reads "Saving…" and then
  "Saved". The browser warns before the page closes while edits have not
  reached Liveblocks yet, and before it closes with a changed scratch draft
  when no one is signed in.

## Setting it up

The function needs three environment variables. For local testing they go in
`.env`, which git ignores. On the live site they are Netlify environment
variables.

| Variable | What it is |
|---|---|
| `LIVEBLOCKS_SECRET_KEY` | The secret key (`sk_…`) of the Liveblocks project, under *API keys* in the Liveblocks dashboard. |
| `GOOGLE_CLIENT_ID` | The OAuth client ID for the Google sign-in button (see below). It is public. |
| `DRAFTS_SESSION_SECRET` | At least 32 random characters, used to sign session tokens. Make one with `openssl rand -base64 48`. Use a different value on the live site from the one in `.env`. Changing it signs everyone out. |

### The Google client ID

1. Open the [Google Cloud console](https://console.cloud.google.com/) and
   create a project, for example "CORE-AIx drafter".
2. Go to *APIs & Services → OAuth consent screen* (called *Google Auth
   Platform → Branding* in newer consoles). Choose **External** and enter the
   app name and a support e-mail address. Then, under *Audience*, choose
   **Publish app**. The page asks only for name, e-mail and picture, so Google
   does not need to review it.
3. Go to *Credentials → Create credentials → OAuth client ID*. Choose **Web
   application** and add these **Authorised JavaScript origins**:
   - `https://core-aix.org`
   - `http://localhost`
   - `http://localhost:8888` (for `netlify dev`)

   No redirect URIs are needed.
4. Copy the client ID (`….apps.googleusercontent.com`) into
   `GOOGLE_CLIENT_ID`.

### Netlify environment variables

1. In the Netlify dashboard, open the site and go to **Site configuration →
   Environment variables → Add a variable → Add a single variable**.
2. Add each of the three variables above. Their scope must include
   *Functions*, which is the default.
3. Go to **Deploys → Trigger deploy → Deploy site** so the function picks
   them up.

You can do the same from a terminal with `netlify link` and then
`netlify env:set NAME value` for each variable.

### Running it locally

```
netlify dev --port 8888
```

Then open `http://localhost:8888/openreview-drafter/`. `netlify dev` reads
`.env` and runs the function and a local Netlify Blobs store.

## Limits

- **Liveblocks free plan.** At most 10 people in one draft at once, 500 drafts
  active in a month, and 10 MB per draft. A small Liveblocks badge is shown,
  which the free plan requires.
- **Removing someone.** Access is checked when a person connects to a draft.
  Someone already editing keeps working until they reload or lose the
  connection.
- **Signing out.** Signing out forgets the session in that browser. A session
  token that was copied elsewhere stays valid until it expires (30 days), or
  until `DRAFTS_SESSION_SECRET` is changed.
