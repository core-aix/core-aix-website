/**
 * Live statistics backend for the three-armed bandit game used in the lecture.
 *
 * One game at a time. There is no session name and no epoch, because a lecture
 * runs one activity and a reset should leave nothing behind. A reset deletes
 * every player record, and a phone whose record has gone is told to join
 * again, which is the whole of the recovery path.
 *
 * Endpoints, all under /api/bandit:
 *
 *   GET  /settings                  the settings, created on demand
 *   POST /join      {name}          issues a player id and a write token
 *   POST /sync      {id, token, …}  upserts one player's record
 *   GET  /board?full=1              the aggregate the dashboard shows
 *   POST /admin     {key, action}   wipe the records or change the settings
 *
 * Every player owns one blob and writes only that blob, so two students
 * finishing at the same moment can never overwrite each other. The aggregate
 * is assembled on read instead, behind a short in-memory cache.
 */
import { getStore } from '@netlify/blobs';

export const config = { path: ['/api/bandit', '/api/bandit/*'] };

const STORE = 'bandit-game';
const MAX_PLAYERS = 500;
const MAX_NAME = 18;
const MAX_BODY = 96 * 1024;
const MAX_STEPS = 400;
const CACHE_MS = 1200;

/* A round has no fixed length, so a score is the share of pulls that paid and
 * a total is not comparable between two players. Ten pulls is the point at
 * which that share means anything, and a shorter round is listed under the
 * ranked ones rather than above them. */
const MIN_RANKED_PULLS = 10;

const DEFAULT_SETTINGS = { k: 3, open: true };
/* Raised whenever the shape of the settings changes, so a stored copy from an
 * older shape of the game is replaced rather than served to a phone. */
const SETTINGS_VERSION = 3;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...CORS,
    },
  });

/* Netlify turns a 403 from a function into a 404 and falls through to the
 * static site, so a refusal is reported as 409 instead. */
const fail = (message, status = 400) => json({ error: message }, status);

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function num(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function numberArray(raw) {
  if (!Array.isArray(raw)) return null;
  const out = raw.slice(0, MAX_STEPS).map((x) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.round(n * 1000) / 1000 : 0;
  });
  return out;
}

function curve(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = numberArray(raw.r);
  const o = numberArray(raw.o);
  if (!r || !o || r.length === 0 || r.length !== o.length) return null;
  return { r, o };
}

function firstRound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const c = curve(raw.curve);
  if (!c) return null;
  const base = raw.base && typeof raw.base === 'object' ? raw.base : {};
  const out = {
    k: num(raw.k, 2, 64, 3),
    pulls: Math.round(num(raw.pulls, 1, 1e6, c.r.length)),
    avg: num(raw.avg, 0, 1, 0),
    optimalFrac: num(raw.optimalFrac, 0, 1, 0),
    optimalMean: num(raw.optimalMean, 0, 1, 0),
    /* A round still running sends its curve every ten seconds, so this one is
     * replaced as it grows and frozen once the round ends. */
    final: raw.final === true,
    curve: c,
    base: {},
  };
  for (const key of ['eps', 'ucb', 'greedy']) {
    const b = curve(base[key]);
    if (b && b.r.length === c.r.length) out.base[key] = b;
  }
  return out;
}

function liveState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    k: Math.round(num(raw.k, 2, 64, 3)),
    pulls: Math.round(num(raw.pulls, 0, 1e6, 0)),
    wins: Math.round(num(raw.wins, 0, 1e6, 0)),
    optimalPulls: Math.round(num(raw.optimalPulls, 0, 1e6, 0)),
    finished: raw.finished === true,
  };
}

/* Everything one phone has pulled, across rounds. The class tally adds these
 * up, so it climbs through the activity instead of dropping back whenever a
 * student starts again. */
function totalsState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rows = Array.isArray(raw.byRate) ? raw.byRate.slice(0, 64) : [];
  return {
    pulls: Math.round(num(raw.pulls, 0, 1e7, 0)),
    wins: Math.round(num(raw.wins, 0, 1e7, 0)),
    byRate: rows.map((row) => ({
      rate: Math.round(num(row && row.rate, 0, 1, 0) * 1000) / 1000,
      pulls: Math.round(num(row && row.pulls, 0, 1e7, 0)),
      wins: Math.round(num(row && row.wins, 0, 1e7, 0)),
    })),
  };
}

/* The class split by the arm's true pay rate, not by its number, because the
 * arms are dealt in a different order to every student. This is the one
 * answer the dashboard has to keep off the live page, since a room that can
 * see the pay rates has been handed the game, so it rides only on a request
 * that asks for it. */
function armSplit(players) {
  const byRate = new Map();
  let total = 0;
  for (const player of players) {
    const rows = player.totals && player.totals.byRate;
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const key = row.rate.toFixed(3);
      const acc = byRate.get(key) || { rate: row.rate, pulls: 0, wins: 0 };
      acc.pulls += row.pulls;
      acc.wins += row.wins;
      byRate.set(key, acc);
      total += row.pulls;
    }
  }
  return [...byRate.values()]
    .sort((a, b) => b.rate - a.rate)
    .map((a) => ({
      rate: a.rate,
      pulls: a.pulls,
      wins: a.wins,
      share: total ? Math.round((a.pulls / total) * 1000) / 1000 : 0,
      paid: a.pulls ? Math.round((a.wins / a.pulls) * 1000) / 1000 : 0,
    }));
}

function bestState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pulls = Math.round(num(raw.pulls, 1, 1e6, 1));
  return {
    avg: num(raw.avg, 0, 1, 0),
    wins: Math.round(num(raw.wins, 0, 1e6, 0)),
    pulls,
    optimalFrac: num(raw.optimalFrac, 0, 1, 0),
  };
}

/* A ranked round always beats an unranked one, then the higher share of pulls
 * paid, then the longer round. The same order the phone applies to itself. */
function betterScore(candidate, current) {
  if (!current) return true;
  const a = candidate.pulls >= MIN_RANKED_PULLS;
  const b = current.pulls >= MIN_RANKED_PULLS;
  if (a !== b) return a;
  if (candidate.avg !== current.avg) return candidate.avg > current.avg;
  return candidate.pulls > current.pulls;
}

const randomId = (n = 12) => {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, n * 1.5);
};

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

const store = () => getStore({ name: STORE, consistency: 'strong' });

/* The keys carry their own namespace. Earlier versions stored a settings blob
 * per session at settings/<name> and a player at p/<name>/<epoch>/<id>, so a
 * bare `settings` key collides with that directory in the local store, and a
 * bare `p/` prefix would list every player from every session ever run. */
const SETTINGS_KEY = 'v3/settings';
const PLAYER_PREFIX = 'v3/player/';
const LEGACY_PREFIXES = ['p/', 'settings/'];
const playerKey = (id) => `${PLAYER_PREFIX}${id}`;

async function readSettings() {
  const blobs = store();
  const found = await blobs.get(SETTINGS_KEY, { type: 'json' });
  if (found && typeof found === 'object' && found.v === SETTINGS_VERSION) {
    return {
      k: Math.round(num(found.k, 2, 32, DEFAULT_SETTINGS.k)),
      open: found.open !== false,
    };
  }
  const fresh = { ...DEFAULT_SETTINGS, v: SETTINGS_VERSION, createdAt: Date.now() };
  await blobs.setJSON(SETTINGS_KEY, fresh);
  return { k: fresh.k, open: fresh.open };
}

async function listPlayers() {
  const blobs = store();
  const { blobs: entries } = await blobs.list({ prefix: PLAYER_PREFIX });
  const keys = entries.map((entry) => entry.key).slice(0, MAX_PLAYERS);
  const records = await Promise.all(
    keys.map((key) => blobs.get(key, { type: 'json' }).catch(() => null)),
  );
  return records.filter((record) => record && record.id);
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

const cache = new Map();

function meanCurves(players) {
  const contributors = players.filter((p) => p.first && p.first.curve);
  const blank = { n: 0, steps: 0, optimalMean: 0 };
  for (const key of ['students', 'eps', 'ucb', 'greedy']) blank[key] = { r: [], o: [] };
  if (!contributors.length) return blank;

  const steps = Math.min(
    MAX_STEPS,
    Math.max(...contributors.map((p) => p.first.curve.r.length)),
  );
  const zeros = () => new Float64Array(steps);
  const acc = {};
  for (const key of ['students', 'eps', 'ucb', 'greedy']) {
    acc[key] = { r: zeros(), o: zeros(), n: zeros() };
  }
  let optimalMean = 0;

  for (const player of contributors) {
    const first = player.first;
    optimalMean += first.optimalMean || 0;
    const add = (slot, source) => {
      const n = Math.min(steps, source.r.length);
      for (let t = 0; t < n; t += 1) {
        slot.r[t] += source.r[t];
        slot.o[t] += source.o[t];
        slot.n[t] += 1;
      }
    };
    add(acc.students, first.curve);
    for (const key of ['eps', 'ucb', 'greedy']) {
      if (first.base && first.base[key]) add(acc[key], first.base[key]);
    }
  }

  /* Everything is plotted, out to the longest round anybody played. The tail
   * rests on fewer and fewer students, so the count behind each step rides
   * along in `support` and the dashboard says where it thins rather than
   * cutting the curve off and leaving the room wondering why it stopped. */
  const finish = (slot) => {
    const r = [];
    const o = [];
    for (let t = 0; t < steps; t += 1) {
      const n = slot.n[t];
      r.push(n ? Math.round((slot.r[t] / n) * 1000) / 1000 : null);
      o.push(n ? Math.round((slot.o[t] / n) * 1000) / 1000 : null);
    }
    return { r, o };
  };

  const out = {
    n: contributors.length,
    steps,
    support: Array.from(acc.students.n, (x) => x),
    optimalMean: Math.round((optimalMean / contributors.length) * 1000) / 1000,
  };
  for (const key of ['students', 'eps', 'ucb', 'greedy']) out[key] = finish(acc[key]);
  return out;
}

async function board(full, limit) {
  const cacheKey = `${full ? 1 : 0}|${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const settings = await readSettings();
  const players = await listPlayers();

  let playing = 0;
  let finished = 0;
  const scored = [];
  const histogram = new Array(11).fill(0);
  const round3 = (x) => Math.round(x * 1000) / 1000;

  for (const player of players) {
    const l = player.live;
    const live = l && l.pulls > 0 ? {
      avg: round3(l.wins / l.pulls),
      wins: l.wins,
      pulls: l.pulls,
      optimalFrac: round3(l.optimalPulls / l.pulls),
      inPlay: l.finished !== true,
    } : null;

    if (live && live.inPlay) playing += 1;
    if (player.best) finished += 1;

    /* A round in progress counts. Rounds have no fixed length, so a player who
     * has not stopped yet would otherwise be missing from the board for the
     * whole activity, which is the opposite of what a live board is for. */
    let score = player.best || null;
    if (live && betterScore(live, score)) score = live;
    if (!score) continue;

    /* The count beside a name is every pull that player has taken, which is
     * what a reader takes the word to mean. Reporting the length of whichever
     * round happens to be scoring best showed 63 beside somebody who had
     * pulled 246 times over three rounds. The score stays the best round's,
     * since that is the competition. */
    const lifetime = (player.totals && player.totals.pulls) || score.pulls;

    const ranked = score.pulls >= MIN_RANKED_PULLS;
    scored.push({
      id: player.id,
      name: player.name,
      avg: score.avg,
      wins: score.wins,
      pulls: lifetime,
      scorePulls: score.pulls,
      optimalFrac: score.optimalFrac,
      ranked,
      /* Mid round is mid round, whichever round is scoring. */
      playing: !!(live && live.inPlay),
      rounds: player.rounds || 0,
    });
    if (ranked) {
      const bin = Math.min(10, Math.max(0, Math.round(score.optimalFrac * 10)));
      histogram[bin] += 1;
    }
  }
  scored.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    if (b.avg !== a.avg) return b.avg - a.avg;
    return b.pulls - a.pulls;
  });

  const pulled = players.reduce((sum, p) => sum +
    ((p.totals && p.totals.pulls) || (p.live && p.live.pulls) || 0), 0);
  const won = players.reduce((sum, p) => sum +
    ((p.totals && p.totals.wins) || (p.live && p.live.wins) || 0), 0);

  const data = {
    settings,
    minRankedPulls: MIN_RANKED_PULLS,
    counts: {
      joined: players.length,
      playing,
      finished,
      pulls: pulled,
      wins: won,
      paid: pulled ? Math.round((won / pulled) * 1000) / 1000 : 0,
    },
    leaderboard: scored.slice(0, limit),
    histogram,
    updatedAt: Date.now(),
  };

  if (full) {
    data.curves = meanCurves(players);
    data.arms = armSplit(players);
    data.live = players
      .filter((p) => p.live && p.live.pulls > 0 && p.live.finished !== true)
      .map((p) => ({ name: p.name, pulls: p.live.pulls }))
      .sort((a, b) => b.pulls - a.pulls)
      .slice(0, 40);
  }

  cache.set(cacheKey, { at: Date.now(), data });
  if (cache.size > 40) cache.clear();
  return data;
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function parseBody(req) {
  const length = Number(req.headers.get('content-length') || 0);
  if (length > MAX_BODY) throw new Error('payload too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('payload too large');
  if (!text) return {};
  return JSON.parse(text);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/bandit\/?/, '').replace(/\/+$/, '') || 'settings';

  try {
    if (req.method === 'GET') {
      if (route === 'settings') {
        return json({ settings: await readSettings() });
      }
      if (route === 'board') {
        const limit = num(url.searchParams.get('limit'), 1, 200, 20);
        const full = url.searchParams.get('full') === '1';
        return json(await board(full, Math.round(limit)));
      }
      return fail('unknown route', 404);
    }

    if (req.method !== 'POST') return fail('method not allowed', 405);

    const body = await parseBody(req);

    if (route === 'join') {
      const name = cleanName(body.name);
      if (name.length < 2) return fail('name too short');
      const settings = await readSettings();
      if (!settings.open) return fail('joining is closed', 409);

      const blobs = store();
      const { blobs: entries } = await blobs.list({ prefix: PLAYER_PREFIX });
      if (entries.length >= MAX_PLAYERS) return fail('the game is full', 409);

      const id = randomId(8);
      const token = randomId(12);
      const record = {
        id,
        token,
        name,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
        rounds: 0,
        live: null,
        totals: null,
        best: null,
        first: null,
      };
      await blobs.setJSON(playerKey(id), record);
      return json({ id, token, name, settings, rounds: 0, best: null });
    }

    if (route === 'sync') {
      const id = String(body.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const token = String(body.token || '').slice(0, 64);
      if (!id || !token) return fail('missing identity');

      const blobs = store();
      const key = playerKey(id);
      const existing = await blobs.get(key, { type: 'json' });
      if (!existing) return json({ ok: false, rejoin: true }, 409);
      if (existing.token !== token) return fail('token mismatch', 409);

      const incomingBest = bestState(body.best);
      const record = {
        ...existing,
        name: cleanName(body.name) || existing.name,
        updatedAt: Date.now(),
        rounds: Math.max(existing.rounds || 0, Math.round(num(body.rounds, 0, 10000, 0))),
        live: liveState(body.live) || existing.live,
        totals: totalsState(body.totals) || existing.totals || null,
      };
      if (incomingBest && betterScore(incomingBest, existing.best)) {
        record.best = incomingBest;
      }
      /* The curve of a round in progress keeps arriving and keeps replacing
       * the one held, so the class charts fill while the room is playing
       * instead of waiting for anybody to stop. Once a round has ended its
       * curve is final and a later round cannot overwrite it, which is what
       * stops a second attempt inflating the class average. */
      if (body.first && !(existing.first && existing.first.final)) {
        const first = firstRound(body.first);
        if (first) record.first = first;
      }
      await blobs.setJSON(key, record);
      return json({ ok: true });
    }

    if (route === 'admin') {
      const expected = process.env.BANDIT_ADMIN_KEY || '';
      if (expected && String(body.key || '') !== expected) return fail('bad key', 409);

      const blobs = store();
      const settings = await readSettings();

      /* A reset deletes every player record outright. Nothing is hidden behind
       * a generation counter, so nothing can come back, and a phone still
       * playing is told to join again on its next sync. */
      if (body.action === 'reset') {
        const { blobs: entries } = await blobs.list({ prefix: PLAYER_PREFIX });
        await Promise.all(entries.map((entry) => blobs.delete(entry.key).catch(() => null)));
        /* Anything left by an older shape of the game goes too, so a wipe
         * really does leave the store empty. */
        let legacy = 0;
        for (const prefix of LEGACY_PREFIXES) {
          try {
            const old = await blobs.list({ prefix });
            legacy += old.blobs.length;
            await Promise.all(old.blobs.map((b) => blobs.delete(b.key).catch(() => null)));
          } catch (err) { /* nothing of that shape is left */ }
        }
        cache.clear();
        return json({ ok: true, cleared: entries.length, legacy, settings });
      }

      if (body.action === 'settings') {
        const patch = body.settings || {};
        const updated = {
          k: Math.round(num(patch.k, 2, 32, settings.k)),
          open: patch.open === undefined ? settings.open : patch.open !== false,
          v: SETTINGS_VERSION,
        };
        await blobs.setJSON(SETTINGS_KEY, updated);
        cache.clear();
        return json({ ok: true, settings: { k: updated.k, open: updated.open } });
      }

      return fail('unknown action');
    }

    return fail('unknown route', 404);
  } catch (error) {
    const message = error && error.message ? error.message : 'unexpected error';
    const status = message === 'payload too large' ? 413 : 500;
    return json({ error: message }, status);
  }
}
