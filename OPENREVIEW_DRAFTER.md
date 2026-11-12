# The OpenReview Drafter

A page for writing OpenReview replies together, at
`https://core-aix.org/openreview-drafter/`. You write maths as in a paper, and
the page shows the reply exactly as OpenReview will render it. It also gives
the text to paste into OpenReview, with the extra backslashes that OpenReview
needs.

Anyone can use the page without an account, just to convert text. Signing in
with Google saves drafts and lets several people edit one draft at the same
time. A draft can also be opened through a share link, without signing in.

```
static/openreview-drafter/        the page (copied from the openreview-markdown repository)
  index.html, app.js, style.css
  escape.js                       standard <-> OpenReview Markdown conversion
  or-render.js                    OpenReview's own Markdown settings
  vendor/collab.js                CodeMirror, Yjs, the Liveblocks client and the spell checker, bundled
  vendor/spell-worker.js          nspell, which checks spelling in a background worker
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
- **Sharing by e-mail.** Any member can add someone by e-mail address. The
  owner can remove anyone, and anyone can leave. Only the owner can delete a
  draft. The person added signs in with Google using that address and then
  finds the draft in their list.
- **Share links.** Any member can copy the draft's share link
  (`…/openreview-drafter/#s=<token>`, 256 random bits). It opens the draft
  without signing in, as a guest. Guests choose a display name. The owner
  sets the link to *can edit* (the default), *can view* or *off*, and can
  reset it, which makes the old link stop working. The token is kept in the
  room metadata (`linkToken`, `linkMode`). Guests get a Liveblocks access
  token for that one room only, and it is read-only for a *view* link. The
  token sits after `#`, so browsers never send it to the server in the page
  request.
- **Versions.** The function saves versions in Netlify Blobs
  (`ver/<id>/<time>` holds `{at, by, text, note}`). The page asks for one a
  minute after someone stops typing, at least every five minutes while they
  keep typing, and when the page is hidden or goes idle. The function then
  reads the text from Liveblocks itself and stores it only if it changed, at
  most once every two minutes, keeping the latest 300 per draft. *History*
  lists a draft's versions; each can be viewed, downloaded or restored.
  Restoring first saves the current text as a version, so it can be undone.
- **Deleted drafts.** Deleting saves a last version and keeps a record
  (`del/<id>`, with `delidx/<email>/<id>` for each member). *Deleted drafts…*
  at the bottom of the drafts list shows them to everyone who was a member,
  with their versions. The owner can restore a draft, with its members and
  its latest text, or delete it for good, which also removes its versions.
- **Spell check.** Hunspell dictionaries for ten languages load on demand from
  jsdelivr and are checked in a background worker. Maths, LaTeX commands,
  code, URLs and HTML are skipped. Right-click an underlined word for
  suggestions, *Add to dictionary* (kept in that browser) or *Ignore*.
- **Idle connections.** Liveblocks bills by connection time. A visible page
  with no key press, click, scroll or touch for 5 minutes disconnects, once
  everything is saved, and shows "Paused while idle". The next key press or
  click reconnects it, and edits made in between are merged. A tab in the
  background disconnects after 1 minute and reconnects when it is shown again
  (Liveblocks' `backgroundKeepAliveTimeout`).
- **Comments.** Signed-in members (and signed-in people on an edit link) can
  comment on selected text in Standard Markdown. Comments live in the room's
  Yjs document next to the text (a `comments` map), so they sync live and need
  nothing on the server. Each one is anchored with Yjs relative positions, so
  it follows edits. If all of its text is deleted, it stays in the list,
  marked as such. Versions hold only the text, not comments.
- **Out-of-date warning.** When the page is offline, has lost its connection,
  or is paused while idle, a banner says that what it shows may not be the
  latest version, and names who was in the draft in the last 10 minutes.
  *Copy* warns in the same way. After reconnecting, the page says so if
  other people's changes came in.
- **Editor and preview position.** The text is split into Markdown blocks with
  marked's lexer, which line up with the preview's top-level elements. With
  *⇅ Sync* on, scrolling either side scrolls the other to the same block.
  Double-clicking the preview moves the editor there.
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
- **Removing someone, or changing a link.** Access is checked when a person
  connects. Someone already editing keeps working until they reconnect, which
  happens at the latest after they go idle or the tab sits in the background.
- **Signing out.** Signing out forgets the session in that browser. A session
  token that was copied elsewhere stays valid until it expires (30 days), or
  until `DRAFTS_SESSION_SECRET` is changed.
