# The bandit game backend

The lecture on exploration and exploitation runs a three-armed bandit phone
game. The players' app
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
| `/settings` | GET | | the settings, created on first use |
| `/join` | POST | `name` | a player id and a write token |
| `/sync` | POST | `id`, `token`, `live`, `totals`, `best`, `first` | acknowledgement |
| `/board` | GET | `full`, `limit` | the aggregate the dashboard shows |
| `/admin` | POST | `key`, `action` | wipe the records or change the settings |

**One game at a time.** There is no session name and no generation counter. A
lecture runs one activity, and a wipe deletes every player record outright, so
nothing can come back. A phone whose record has gone is refused on its next
sync with `rejoin`, joins again under the same name, and keeps the round it is
in, which is the whole of the recovery path.

Keys carry their own namespace, `v3/settings` and `v3/player/<id>`. Earlier
versions stored a settings blob per session and a player under the session and
the generation, so a bare `settings` key collides with that directory in the
local store and a bare `p/` prefix would list every player from every session
ever run. A wipe clears those older shapes too.

Every player owns one blob and writes only that blob, so two students finishing
at the same moment cannot overwrite each other. The aggregate is assembled on
read, behind an in-memory cache of 1.2 seconds. A refusal comes back as 409,
because Netlify turns a 403 from a function into a 404 and falls through to the
static site.

`first` carries the curves of a player's first round together with the three
reference agents replayed on that player's own arms. Only the first round counts
towards the class average, so a second attempt cannot inflate it. The
leaderboard uses the best round.

A round has no fixed length. A student pulls as often as they like and stops
when they choose, so a total is not comparable between two students and the
score is the share of pulls that paid. The curve goes up every ten seconds from
the tenth pull onward, so the class charts fill while the room plays rather
than waiting for anybody to stop, and it is frozen when that round ends. Ten pulls is the point at which that
share means anything, so a shorter round still shows its average and sorts under
the ranked ones. Rounds of different lengths make the class curves ragged, and a
step is plotted only where enough rounds were still running to say anything
about the cohort.

Settings carry a version. Raising it makes the next read replace a stored copy
from an older shape of the game rather than serving it to a phone.

## Settings

Set `BANDIT_ADMIN_KEY` in the Netlify site environment. Without it the dashboard
controls are open to anyone who finds the page. The dashboard asks for the key
once and holds it in `localStorage`.

## The dashboard

`https://core-aix.org/bandit/` is deliberately outside the site navigation and
carries `noindex`. Open Controls, set the session name and the Vercel link, and
the QR code follows. The same values ride in the query string if that is easier.

The page has two views. The live one carries the QR code, the share of the
class's pulls that paid, and the leaderboard, which ranks a round still in
progress alongside a finished one so the board fills as the room plays. Nothing
on it names an arm or a pay rate.

**Reveal the results** switches to the second view, which carries the pay rates,
where the class put its pulls, and the curves against greedy, epsilon-greedy and
UCB. A room that can see the pay rates has been handed the game, so the live
view never even requests them. The curves and the arm split ride only on a
request carrying `full=1`, which only the reveal view makes.

```
https://core-aix.org/bandit/?join=https://your-app.vercel.app
```

Controls also sets the number of arms, which the phones pick up on their next
round without a redeploy, and **Wipe all records** deletes everything.

## Running it locally

```bash
npm install
BANDIT_ADMIN_KEY=testkey netlify dev --offline --port 8899
```

The dashboard is then at `http://localhost:8899/bandit/` and the API at
`http://localhost:8899/api/bandit`.
