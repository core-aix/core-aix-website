# The bandit game backend

The lecture on exploration and exploitation runs a phone game. The players' app
lives in its own repository on Vercel. This repository holds the two pieces that
stay here, the API and the projector dashboard.

```
netlify/functions/bandit.mjs   the API, backed by Netlify Blobs
static/bandit/index.html       the dashboard, shown on the lecture screen
static/bandit/dashboard.css
static/bandit/dashboard.js
static/bandit/qr.js            a small QR generator, no external script
```

## The API

All routes sit under `/api/bandit`.

| Route | Method | Body or query | Answer |
|---|---|---|---|
| `/settings` | GET | `session` | the session settings, created on first use |
| `/join` | POST | `session`, `name` | a player id and a write token |
| `/sync` | POST | `session`, `id`, `token`, `live`, `best`, `first` | acknowledgement |
| `/board` | GET | `session`, `full`, `limit` | the aggregate the dashboard shows |
| `/admin` | POST | `session`, `key`, `action` | reset the session or change its settings |

Every player owns one blob and writes only that blob, so two students finishing
at the same moment cannot overwrite each other. The aggregate is assembled on
read, behind an in-memory cache of 1.2 seconds. A refusal comes back as 409,
because Netlify turns a 403 from a function into a 404 and falls through to the
static site.

`first` carries the curves of a player's first round together with the three
reference agents replayed on that player's own arms. Only the first round counts
towards the class average, so a second attempt cannot inflate it. The
leaderboard uses the best round.

## Settings

Set `BANDIT_ADMIN_KEY` in the Netlify site environment. Without it the dashboard
controls are open to anyone who finds the page. The dashboard asks for the key
once and holds it in `localStorage`.

## The dashboard

`https://core-aix.org/bandit/` is deliberately outside the site navigation and
carries `noindex`. Open Controls, set the session name and the Vercel link, and
the QR code follows. The same values ride in the query string if that is easier.

```
https://core-aix.org/bandit/?s=l02&join=https://your-app.vercel.app
```

## Running it locally

```bash
npm install
BANDIT_ADMIN_KEY=testkey netlify dev --offline --port 8899
```

The dashboard is then at `http://localhost:8899/bandit/` and the API at
`http://localhost:8899/api/bandit`.
