/**
 * Live statistics backend for the three-armed bandit game used in the lecture.
 *
 * Endpoints, all under /api/bandit:
 *
 *   GET  /settings?session=l02          the session settings, created on demand
 *   POST /join      {session, name}     issues a player id and a write token
 *   POST /sync      {session, id, ...}  upserts one player's record
 *   GET  /board?session=l02&full=1      the aggregate the dashboard shows
 *   POST /admin     {session, key, ...} reset the session or change settings
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

const DEFAULT_SETTINGS = { k: 3, open: true, epoch: 1 };
/* Raised whenever the shape of a session changes, so a session created under
 * the old game does not serve stale settings to a phone. The epoch survives,
 * because it is what tells a phone to start again. */
const SETTINGS_VERSION = 2;

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

function sessionId(raw) {
  const s = String(raw || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
  return s || 'default';
}

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

const settingsKey = (session) => `settings/${session}`;
const playerPrefix = (session, epoch) => `p/${session}/${epoch}/`;
const playerKey = (session, epoch, id) => `${playerPrefix(session, epoch)}${id}`;

async function readSettings(session) {
  const blobs = store();
  const found = await blobs.get(settingsKey(session), { type: 'json' });
  if (found && typeof found === 'object' && found.v === SETTINGS_VERSION) {
    return {
      k: Math.round(num(found.k, 2, 32, DEFAULT_SETTINGS.k)),
      open: found.open !== false,
      epoch: num(found.epoch, 1, 1e9, 1),
    };
  }
  const epoch = found && typeof found === 'object'
    ? num(found.epoch, 1, 1e9, 1) : 1;
  const fresh = { ...DEFAULT_SETTINGS, epoch, v: SETTINGS_VERSION, createdAt: Date.now() };
  await blobs.setJSON(settingsKey(session), fresh);
  return { k: fresh.k, open: fresh.open, epoch: fresh.epoch };
}

async function listPlayers(session, epoch) {
  const blobs = store();
  const prefix = playerPrefix(session, epoch);
  const { blobs: entries } = await blobs.list({ prefix });
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

  /* A step reached by three players out of forty says nothing about the class,
   * so the tail is cut where too few rounds are still running. A small class
   * keeps everybody, since a floor above the class size would plot nothing. */
  const n = contributors.length;
  const floor = Math.max(1, Math.min(5, n), Math.ceil(0.35 * n));
  const finish = (slot) => {
    const r = [];
    const o = [];
    for (let t = 0; t < steps; t += 1) {
      const n = slot.n[t];
      const enough = n >= floor;
      r.push(enough ? Math.round((slot.r[t] / n) * 1000) / 1000 : null);
      o.push(enough ? Math.round((slot.o[t] / n) * 1000) / 1000 : null);
    }
    return { r, o };
  };

  const out = {
    n: contributors.length,
    steps,
    optimalMean: Math.round((optimalMean / contributors.length) * 1000) / 1000,
  };
  for (const key of ['students', 'eps', 'ucb', 'greedy']) out[key] = finish(acc[key]);
  return out;
}

async function board(session, full, limit) {
  const cacheKey = `${session}|${full ? 1 : 0}|${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const settings = await readSettings(session);
  const players = await listPlayers(session, settings.epoch);

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
    let onAir = false;
    if (live && betterScore(live, score)) {
      score = live;
      onAir = live.inPlay;
    }
    if (!score) continue;

    const ranked = score.pulls >= MIN_RANKED_PULLS;
    scored.push({
      id: player.id,
      name: player.name,
      avg: score.avg,
      wins: score.wins,
      pulls: score.pulls,
      optimalFrac: score.optimalFrac,
      ranked,
      playing: onAir,
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
    session,
    epoch: settings.epoch,
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
      const session = sessionId(url.searchParams.get('session'));
      if (route === 'settings') {
        return json({ session, settings: await readSettings(session) });
      }
      if (route === 'board') {
        const limit = num(url.searchParams.get('limit'), 1, 200, 20);
        const full = url.searchParams.get('full') === '1';
        return json(await board(session, full, Math.round(limit)));
      }
      return fail('unknown route', 404);
    }

    if (req.method !== 'POST') return fail('method not allowed', 405);

    const body = await parseBody(req);
    const session = sessionId(body.session);

    if (route === 'join') {
      const name = cleanName(body.name);
      if (name.length < 2) return fail('name too short');
      const settings = await readSettings(session);
      if (!settings.open) return fail('the session is closed', 409);

      const blobs = store();
      const { blobs: entries } = await blobs.list({ prefix: playerPrefix(session, settings.epoch) });
      if (entries.length >= MAX_PLAYERS) return fail('the session is full', 409);

      const id = randomId(8);
      const token = randomId(12);
      const record = {
        id,
        token,
        name,
        epoch: settings.epoch,
        joinedAt: Date.now(),
        updatedAt: Date.now(),
        rounds: 0,
        live: null,
        totals: null,
        best: null,
        first: null,
      };
      await blobs.setJSON(playerKey(session, settings.epoch, id), record);
      return json({ id, token, name, settings, rounds: 0, best: null, firstDone: false });
    }

    if (route === 'sync') {
      const id = String(body.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const token = String(body.token || '').slice(0, 64);
      if (!id || !token) return fail('missing identity');

      const settings = await readSettings(session);
      const blobs = store();
      const key = playerKey(session, settings.epoch, id);
      const existing = await blobs.get(key, { type: 'json' });
      if (!existing) return json({ ok: false, epoch: settings.epoch, rejoin: true }, 409);
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
      if (!existing.first && body.first) {
        const first = firstRound(body.first);
        if (first) record.first = first;
      }
      await blobs.setJSON(key, record);
      return json({ ok: true, epoch: settings.epoch });
    }

    if (route === 'admin') {
      const expected = process.env.BANDIT_ADMIN_KEY || '';
      if (expected && String(body.key || '') !== expected) return fail('bad key', 409);

      const blobs = store();
      const settings = await readSettings(session);

      if (body.action === 'reset') {
        const nextEpoch = settings.epoch + 1;
        const updated = { ...settings, epoch: nextEpoch, v: SETTINGS_VERSION };
        await blobs.setJSON(settingsKey(session), updated);
        cache.clear();
        /* Old rounds are cleared afterwards, since the epoch already hides them. */
        try {
          const { blobs: entries } = await blobs.list({ prefix: playerPrefix(session, settings.epoch) });
          await Promise.all(entries.map((entry) => blobs.delete(entry.key).catch(() => null)));
        } catch (err) { /* the epoch bump is what matters */ }
        return json({ ok: true, settings: updated });
      }

      if (body.action === 'settings') {
        const patch = body.settings || {};
        const updated = {
          k: Math.round(num(patch.k, 2, 32, settings.k)),
          open: patch.open === undefined ? settings.open : patch.open !== false,
          epoch: settings.epoch,
          v: SETTINGS_VERSION,
        };
        await blobs.setJSON(settingsKey(session), updated);
        cache.clear();
        return json({ ok: true, settings: updated });
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
