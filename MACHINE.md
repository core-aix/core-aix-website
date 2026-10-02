# The machine game backend

The lecture on optimality and Markov decision processes runs a phone game about
a machine that can be run or serviced. The players' app lives in its own
repository on Vercel. This repository holds the two pieces that stay here, the
API and the projector dashboard. The structure copies the bandit game, which
`BANDIT.md` describes.

```
netlify/functions/machine.mjs   the API, backed by Netlify Blobs (store machine-game)
static/machine/index.html       the dashboard, shown on the lecture screen
static/machine/dashboard.css
static/machine/dashboard.js
static/machine/qr.js            a copy of the bandit dashboard's QR generator
```

## The game

The machine is fast or slow, and every round starts with it fast.

| state | action | reward | next state |
|---|---|---|---|
| fast | run | +4 | fast with probability 0.5, slow with probability 0.5 |
| fast | service | +1 | fast |
| slow | run | +2 | failed, the round ends |
| slow | service | 0 | fast |

Each evening the factory stays open with probability 0.9, and otherwise the
round ends. That probability is the discount of the lecture. The total of a
round is the plain sum of its rewards, so its expectation from the fast state
is the discounted value of the policy played.

The expected totals from the fast state, from a linear solve of the Bellman
equations with discount 0.9, are 8.909 for always run, 27.586 for run when fast
and service when slow, and 10.000 for either policy that services a fast
machine. The second is the optimal policy, and it services a slow machine for
a reward of 0 against 2 for running it.

## The API

All routes sit under `/api/machine`.

| Route | Method | Body or query | Answer |
|---|---|---|---|
| `/settings` | GET | | `{version, openProbability, open}`, created on first use |
| `/join` | POST | `name` | `{id, token, name}` |
| `/sync` | POST | `id`, `token`, `live`, `rounds`, `choices`, `first` | `{ok: true}`, or 409 with `rejoin` |
| `/board` | GET | `full`, `limit` | the aggregate the dashboard shows |
| `/admin` | POST | `key`, `action` | wipe the records or change the settings |

**One game at a time.** As in the bandit game there is no session name and no
generation counter. A wipe deletes every player record outright. A phone whose
record has gone is refused on its next sync with 409 and `rejoin: true`, joins
again under the same name, and keeps the round it is in. A wrong token is
refused the same way.

A sync carries the whole state of one player.

```json
{
  "id": "...", "token": "...",
  "live": {"inRound": true, "day": 4, "total": 14, "state": "slow"},
  "rounds": {"count": 3, "sum": 61, "best": 33, "days": 29},
  "choices": {"fast": {"run": 20, "service": 2}, "slow": {"run": 3, "service": 6}},
  "first": {"total": 12, "days": 6, "choices": {"fast": {"run": 4, "service": 0}, "slow": {"run": 1, "service": 1}}}
}
```

`rounds` covers finished rounds only. `choices` counts every decision across
all rounds. `first` is the first finished round, and the backend freezes it once
it has arrived, so a second attempt cannot change the class figures. A retried
sync can arrive after a newer one, so the record keeps the `rounds` with the
larger count and the larger of each decision count. Totals are clipped at 4 per
day played, the most a day can pay.

Every player owns one blob and writes only that blob, so two students finishing
at the same moment cannot overwrite each other. The aggregate is assembled on
read, behind an in-memory cache of 1.2 seconds. A refusal comes back as 409,
because Netlify turns a 403 from a function into a 404 and falls through to the
static site.

### The board

Without `full`, the board carries the leaderboard and the class tallies.

```
{settings, minRankedRounds: 3,
 players: [{id, name, rounds, mean, best, ranked, live: {inRound, day, total}}],
 class: {players, playing, rounds, days}, updatedAt}
```

`mean` is the mean total over finished rounds and is `null` before the first
one. Players with at least three finished rounds are ranked by `mean`, and the
rest are listed under them. `class.days` counts the days of finished rounds plus
`live.day` of every round still in play. Nothing about choices rides on this
answer.

With `full=1`, which only the reveal view requests, the answer adds

```
reveal: {
  choices: {fast: {run, service}, slow: {run, service}},
  first: {count, meanTotal},
  all: {rounds, meanTotal},
  reference: {alwaysRun: 8.909, optimal: 27.586, serviceFast: 10.0}
}
```

`first.meanTotal` averages each player's first finished round. `all.meanTotal`
averages every finished round. Both are `null` before there is a round.

## Settings

Set `MACHINE_ADMIN_KEY` in the Netlify site environment. Without it the backend
falls back to `BANDIT_ADMIN_KEY`, and without either the controls are open to
anyone who finds the page. The dashboard asks for the key once and holds it in
`localStorage`.

The admin actions are `wipe` (the bandit's word `reset` also works) and
`settings`, whose `settings.open` opens or closes joining. The open probability
is fixed at 0.9, since the reference totals rest on it.

## The dashboard

`https://core-aix.org/machine/` is outside the site navigation and carries
`noindex`. Open Controls, set the Vercel link, and the QR code follows. The link
can also ride in the query string.

```
https://core-aix.org/machine/?join=https://your-app.vercel.app
```

The live view carries the QR code, the model drawn large with the probability
and the reward on every arrow, the number of players, rounds and days, and the
leaderboard. Nothing on it shows a choice or the optimal policy.

**Reveal the results** switches to the second view. For each state it shows
the share of the class's decisions that were run and that were service, with
the optimal action marked. Beside it, the class mean of first rounds and of all
rounds sits against the expected totals of always run and of the optimal policy.

**Wipe all records** in Controls deletes every player.

## Running it locally

```bash
npm install
MACHINE_ADMIN_KEY=testkey netlify dev --offline --port 8899
```

The dashboard is then at `http://localhost:8899/machine/` and the API at
`http://localhost:8899/api/machine`.
