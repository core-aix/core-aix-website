/**
 * Live statistics backend for the ten-armed bandit game used in the lecture.
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
const MAX_STEPS = 1000;
const CACHE_MS = 1200;

const DEFAULT_SETTINGS = { k: 10, budget: 100, open: true, epoch: 1 };

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
    k: num(raw.k, 2, 64, 10),
    budget: c.r.length,
    total: num(raw.total, -1e6, 1e6, 0),
    optimalFrac: num(raw.optimalFrac, 0, 1, 0),
    optimalMean: num(raw.optimalMean, -20, 20, 0),
    curve: c,
    base: {},
  };
  for (const key of ['eps', 'ucb', 'greedy']) {
    const b = curve(base[key]);
    if (b && b.r.length === out.budget) out.base[key] = b;
  }
  return out;
}

function liveState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    k: num(raw.k, 2, 64, 10),
    budget: num(raw.budget, 1, MAX_STEPS, 100),
    pulls: num(raw.pulls, 0, MAX_STEPS, 0),
    total: num(raw.total, -1e6, 1e6, 0),
    optimalPulls: num(raw.optimalPulls, 0, MAX_STEPS, 0),
    finished: raw.finished === true,
  };
}

function bestState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    total: num(raw.total, -1e6, 1e6, 0),
    optimalFrac: num(raw.optimalFrac, 0, 1, 0),
    budget: num(raw.budget, 1, MAX_STEPS, 100),
  };
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
  if (found && typeof found === 'object') {
    return {
      k: num(found.k, 2, 32, DEFAULT_SETTINGS.k),
      budget: num(found.budget, 10, MAX_STEPS, DEFAULT_SETTINGS.budget),
      open: found.open !== false,
      epoch: num(found.epoch, 1, 1e9, 1),
    };
  }
  const fresh = { ...DEFAULT_SETTINGS, createdAt: Date.now() };
  await blobs.setJSON(settingsKey(session), fresh);
  return { k: fresh.k, budget: fresh.budget, open: fresh.open, epoch: fresh.epoch };
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

function meanCurves(players, budget) {
  const zeros = () => new Float64Array(budget);
  const acc = {
    students: { r: zeros(), o: zeros(), n: zeros() },
    eps: { r: zeros(), o: zeros(), n: zeros() },
    ucb: { r: zeros(), o: zeros(), n: zeros() },
    greedy: { r: zeros(), o: zeros(), n: zeros() },
  };
  let optimalMean = 0;
  let counted = 0;

  for (const player of players) {
    const first = player.first;
    if (!first || !first.curve) continue;
    counted += 1;
    optimalMean += first.optimalMean || 0;
    const steps = Math.min(budget, first.curve.r.length);
    for (let t = 0; t < steps; t += 1) {
      acc.students.r[t] += first.curve.r[t];
      acc.students.o[t] += first.curve.o[t];
      acc.students.n[t] += 1;
    }
    for (const key of ['eps', 'ucb', 'greedy']) {
      const b = first.base && first.base[key];
      if (!b) continue;
      const n = Math.min(budget, b.r.length);
      for (let t = 0; t < n; t += 1) {
        acc[key].r[t] += b.r[t];
        acc[key].o[t] += b.o[t];
        acc[key].n[t] += 1;
      }
    }
  }

  const finish = (slot) => {
    const r = [];
    const o = [];
    for (let t = 0; t < budget; t += 1) {
      const n = slot.n[t];
      r.push(n ? Math.round((slot.r[t] / n) * 1000) / 1000 : null);
      o.push(n ? Math.round((slot.o[t] / n) * 1000) / 1000 : null);
    }
    return { r, o };
  };

  return {
    n: counted,
    optimalMean: counted ? Math.round((optimalMean / counted) * 1000) / 1000 : 0,
    students: finish(acc.students),
    eps: finish(acc.eps),
    ucb: finish(acc.ucb),
    greedy: finish(acc.greedy),
  };
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

  for (const player of players) {
    if (player.best) {
      finished += 1;
      scored.push({
        id: player.id,
        name: player.name,
        total: player.best.total,
        optimalFrac: player.best.optimalFrac,
        rounds: player.rounds || 1,
      });
      const bin = Math.min(10, Math.max(0, Math.round(player.best.optimalFrac * 10)));
      histogram[bin] += 1;
    } else if (player.live && player.live.pulls > 0) {
      playing += 1;
    }
  }
  scored.sort((a, b) => b.total - a.total);

  const data = {
    session,
    epoch: settings.epoch,
    settings,
    counts: { joined: players.length, playing, finished },
    leaderboard: scored.slice(0, limit),
    histogram,
    updatedAt: Date.now(),
  };

  if (full) {
    data.curves = meanCurves(players, settings.budget);
    data.live = players
      .filter((p) => p.live && p.live.pulls > 0 && !p.best)
      .map((p) => ({ name: p.name, pulls: p.live.pulls, budget: p.live.budget }))
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
      };
      if (incomingBest && (!existing.best || incomingBest.total > existing.best.total)) {
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
        const updated = { ...settings, epoch: nextEpoch };
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
          budget: Math.round(num(patch.budget, 10, MAX_STEPS, settings.budget)),
          open: patch.open === undefined ? settings.open : patch.open !== false,
          epoch: settings.epoch,
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
