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

This is version 3 of the model. The machine is fast, slow or worn, and every
round starts with it fast on day 1.

| state | action | reward | next state |
|---|---|---|---|
| fast | run | +5 | fast with probability 0.5, slow with probability 0.5 |
| fast | service | +1 | fast |
| slow | run | +4 | slow with probability 0.7, worn with probability 0.3 |
| slow | service | -2 | fast |
| worn | run | +1 | worn with probability 0.6, failed with probability 0.4, the round ends |
| worn | service | -1 | fast |

A round ends for one of two reasons, and only these. Either the machine fails,
or day 20 has been played and the shift is over. There is no discount, and the
total of a round is the plain sum of its rewards, so it lies between -40 and
100. Every finished round counts, so a round that ends early in failure scores
low.

The expected totals from the fast state over 20 days, from exact backward
induction, are

| policy (fast, slow, worn) | expected total |
|---|---|
| run, run, run (always run) | 25.79 |
| run, service, service (service whenever not fast) | 54.89 |
| run, run, service | 72.79 |
| best possible, run, run, service on days 1 to 19 and always run on day 20 | 73.11 |
| any policy that services a fast machine | 20.00 |

The best play keeps a slow machine running, since it still earns 4 a day, and
services only a worn one, except on the last day, when a repair no longer pays
off.

## The API

All routes sit under `/api/machine`.

| Route | Method | Body or query | Answer |
|---|---|---|---|
| `/settings` | GET | | `{version: 3, days: 20, open}`, created on first use |
| `/join` | POST | `name` | `{id, token, name}` |
| `/sync` | POST | `id`, `token`, `live`, `rounds`, `choices`, `first`, `history` | `{ok: true}`, or 409 with `rejoin` |
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
  "live": {"inRound": true, "day": 4, "total": 14, "state": "worn"},
  "rounds": {"count": 3, "sum": 61, "best": 33, "days": 29},
  "choices": {"fast": {"run": 20, "service": 2}, "slow": {"run": 3, "service": 6}, "worn": {"run": 1, "service": 2}},
  "first": {"total": 12, "days": 6, "choices": {"fast": {"run": 4, "service": 0}, "slow": {"run": 1, "service": 1}, "worn": {"run": 0, "service": 1}}},
  "history": [{"total": 12, "days": 6, "ended": "failed"}, {"total": 70, "days": 20, "ended": "shift"}]
}
```

`rounds` covers finished rounds only. `choices` counts every decision across
all rounds. `first` is the first finished round, and the backend freezes it once
it has arrived, so a second attempt cannot change the class figures. A retried
sync can arrive after a newer one, so the record keeps the `rounds` with the
larger count and the larger of each decision count. Totals are clipped to
between -2 and 5 per day played, the least and the most a day can pay, and a
round has at most 20 days.

`history` lists every finished round, newest last, at most 50, each as
`{total, days, ended}` with `ended` either `failed` or `shift`. An entry with
days outside 1 to 20, a total outside -2 to 5 per day or another ending is
dropped. The longer of the stored and the incoming history is kept, so a stale
retry cannot shorten it, and at equal length the sync reporting at least as many
finished rounds wins.
`live.day` is the number of days already played in the round in progress.

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
rest are listed under them, with a player who has no finished round last. `class.days` counts the days of finished rounds plus
`live.day` of every round still in play. Nothing about choices rides on this
answer.

With `full=1`, which only the reveal view requests, the answer adds

```
reveal: {
  choices: {fast: {run, service}, slow: {run, service}, worn: {run, service}},
  first: {count, meanTotal},
  all: {rounds, meanTotal},
  endings: {rounds, failed, shift, failedShare, failedMeanTotal, shiftMeanTotal},
  reference: {alwaysRun: 25.79, serviceWhenNotFast: 54.89, runRunService: 72.79, best: 73.11}
}
```

`first.meanTotal` averages each player's first finished round. `all.meanTotal`
averages every finished round. Both are `null` before there is a round.
`endings` comes from the stored histories, and gives the share of rounds that
ended with a failed machine and the mean total of failed rounds and of completed
shifts.

## Settings

Set `MACHINE_ADMIN_KEY` in the Netlify site environment. Without it the backend
falls back to `BANDIT_ADMIN_KEY`, and without either the controls are open to
anyone who finds the page. The dashboard asks for the key once and holds it in
`localStorage`.

The admin actions are `wipe` (the bandit's word `reset` also works) and
`settings`, whose `settings.open` opens or closes joining. The round length
is fixed at 20 days, since the reference totals rest on it.

## The dashboard

`https://core-aix.org/machine/` is outside the site navigation and carries
`noindex`. Open Controls, set the Vercel link, and the QR code follows. The link
can also ride in the query string.

```
https://core-aix.org/machine/?join=https://your-app.vercel.app
```

The live view carries the QR code, the model drawn with its three working
states in a row and the action, the probability and the reward on every arrow, the number of players, rounds and days, and the
leaderboard. Nothing on it shows a choice or the optimal policy.

**Reveal the results** switches to the second view. For each state it shows
the share of the class's decisions that were run and that were service, with
the best action marked (run when fast, run when slow, service when worn), and a
note that on the last day a worn machine is run too. Beside it, the class mean
of first rounds and of all rounds sits against the expected totals of always
run (25.8), service whenever not fast (54.9) and the best possible play (73.1).
Under those bars, the share of rounds that ended in failure and the mean total
of failed rounds against completed shifts. A negative class mean shows an empty bar beside its
number.

**Wipe all records** in Controls deletes every player.

## Running it locally

```bash
npm install
MACHINE_ADMIN_KEY=testkey netlify dev --offline --port 8899
```

The dashboard is then at `http://localhost:8899/machine/` and the API at
`http://localhost:8899/api/machine`.
