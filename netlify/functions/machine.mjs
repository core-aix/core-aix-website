/**
 * Live statistics backend for the machine game used in the lecture on Markov
 * decision processes.
 *
 * The game. A machine is fast or slow. Running a fast machine pays 4 and
 * leaves it fast or slow with probability one half each. Servicing a fast
 * machine pays 1 and keeps it fast. Running a slow machine pays 2 and the
 * machine fails, which ends the round. Servicing a slow machine pays 0 and
 * makes it fast. Each evening the factory stays open with probability 0.9.
 *
 * One game at a time, as in the bandit game. A wipe deletes every player
 * record, and a phone whose record has gone is told to join again.
 *
 * Endpoints, all under /api/machine:
 *
 *   GET  /settings                  {version, openProbability, open}
 *   POST /join      {name}          issues a player id and a write token
 *   POST /sync      {id, token, …}  upserts one player's record
 *   GET  /board?full=1              the aggregate the dashboard shows
 *   POST /admin     {key, action}   wipe the records or change the settings
 *
 * Every player owns one blob and writes only that blob, so two students
 * finishing at the same moment can never overwrite each other. The aggregate
 * is assembled on read, behind a short in-memory cache.
 */
import { getStore } from '@netlify/blobs';

export const config = { path: ['/api/machine', '/api/machine/*'] };

const STORE = 'machine-game';
const MAX_PLAYERS = 500;
const MAX_NAME = 18;
const MAX_BODY = 32 * 1024;
const CACHE_MS = 1200;

/* A mean over one or two rounds is mostly luck, so a player with fewer
 * finished rounds than this is listed under the ranked ones. */
const MIN_RANKED_ROUNDS = 3;

/* The most a day can pay, so a total larger than this many times the days
 * played cannot be honest and is clipped. */
const MAX_DAY_REWARD = 4;

/* The chance that the factory stays open for another day. It is the discount
 * of the lecture and is fixed, since the reference totals below rest on it. */
const OPEN_PROBABILITY = 0.9;

/* Expected round totals from the fast state, from a linear solve of the
 * Bellman equations with gamma 0.9 for each of the four deterministic
 * policies. Service in the fast state gives 10 whatever the slow action is. */
const REFERENCE = { alwaysRun: 8.909, optimal: 27.586, serviceFast: 10.0 };

const DEFAULT_SETTINGS = { open: true };
/* Raised whenever the shape of the settings changes, so a stored copy from an
 * older shape of the game is replaced instead of being served to a phone. */
const SETTINGS_VERSION = 1;

const STATES = ['fast', 'slow'];
const ACTIONS = ['run', 'service'];

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
const fail = (message, status = 400, extra = {}) => json({ error: message, ...extra }, status);

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

const int = (value, lo, hi, fallback = 0) => Math.round(num(value, lo, hi, fallback));
const round3 = (x) => Math.round(x * 1000) / 1000;

/* Decision counts, {fast: {run, service}, slow: {run, service}}. */
function choicesState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const s of STATES) {
    const row = raw[s] && typeof raw[s] === 'object' ? raw[s] : {};
    out[s] = {};
    for (const a of ACTIONS) out[s][a] = int(row[a], 0, 1e7);
  }
  return out;
}

const emptyChoices = () => ({ fast: { run: 0, service: 0 }, slow: { run: 0, service: 0 } });

/* Counters only ever climb, so a retried sync that arrives after a newer one
 * cannot take a count back down. */
function maxChoices(a, b) {
  if (!a) return b;
  if (!b) return a;
  const out = emptyChoices();
  for (const s of STATES) for (const a2 of ACTIONS) out[s][a2] = Math.max(a[s][a2], b[s][a2]);
  return out;
}

function liveState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const day = int(raw.day, 0, 1e5);
  return {
    inRound: raw.inRound === true,
    day,
    total: int(raw.total, 0, MAX_DAY_REWARD * Math.max(1, day)),
    state: raw.state === 'slow' ? 'slow' : (raw.state === 'failed' ? 'failed' : 'fast'),
  };
}

function roundsState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = int(raw.count, 0, 1e5);
  const days = int(raw.days, count, 1e7, count);
  return {
    count,
    sum: int(raw.sum, 0, MAX_DAY_REWARD * days),
    best: int(raw.best, 0, 1e6),
    days,
  };
}

function firstRound(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const days = int(raw.days, 1, 1e5, 1);
  const choices = choicesState(raw.choices);
  return {
    total: int(raw.total, 0, MAX_DAY_REWARD * days),
    days,
    choices: choices || emptyChoices(),
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

const SETTINGS_KEY = 'v1/settings';
const PLAYER_PREFIX = 'v1/player/';
const playerKey = (id) => `${PLAYER_PREFIX}${id}`;

function publicSettings(stored) {
  return { version: SETTINGS_VERSION, openProbability: OPEN_PROBABILITY, open: stored.open !== false };
}

async function readSettings() {
  const blobs = store();
  const found = await blobs.get(SETTINGS_KEY, { type: 'json' });
  if (found && typeof found === 'object' && found.v === SETTINGS_VERSION) {
    return publicSettings(found);
  }
  const fresh = { ...DEFAULT_SETTINGS, v: SETTINGS_VERSION, createdAt: Date.now() };
  await blobs.setJSON(SETTINGS_KEY, fresh);
  return publicSettings(fresh);
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

async function board(full, limit) {
  const cacheKey = `${full ? 1 : 0}|${limit}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const settings = await readSettings();
  const players = await listPlayers();

  let classRounds = 0;
  let classDays = 0;
  let classSum = 0;
  let playing = 0;
  const rows = [];

  for (const player of players) {
    const r = player.rounds || { count: 0, sum: 0, best: 0, days: 0 };
    const l = player.live;
    const inRound = !!(l && l.inRound);
    classRounds += r.count;
    classSum += r.sum;
    /* Days of finished rounds, plus the days of a round still running, so the
     * tally climbs while the room plays. */
    classDays += r.days + (inRound ? l.day : 0);
    if (inRound) playing += 1;

    rows.push({
      id: player.id,
      name: player.name,
      rounds: r.count,
      mean: r.count ? round3(r.sum / r.count) : null,
      best: r.count ? r.best : null,
      ranked: r.count >= MIN_RANKED_ROUNDS,
      live: { inRound, day: l ? l.day : 0, total: l ? l.total : 0 },
    });
  }

  rows.sort((a, b) => {
    if (a.ranked !== b.ranked) return a.ranked ? -1 : 1;
    const am = a.mean === null ? -1 : a.mean;
    const bm = b.mean === null ? -1 : b.mean;
    if (bm !== am) return bm - am;
    if (b.rounds !== a.rounds) return b.rounds - a.rounds;
    return a.name.localeCompare(b.name);
  });

  const data = {
    settings,
    minRankedRounds: MIN_RANKED_ROUNDS,
    players: rows.slice(0, limit),
    class: { players: players.length, playing, rounds: classRounds, days: classDays },
    updatedAt: Date.now(),
  };

  /* The decisions and the reference totals are the answer to the game, so
   * they ride only on a request that asks for them. */
  if (full) {
    let choices = emptyChoices();
    let firstCount = 0;
    let firstSum = 0;
    for (const player of players) {
      if (player.choices) {
        const sum = emptyChoices();
        for (const s of STATES) for (const a of ACTIONS) {
          sum[s][a] = choices[s][a] + player.choices[s][a];
        }
        choices = sum;
      }
      if (player.first) {
        firstCount += 1;
        firstSum += player.first.total;
      }
    }
    data.reveal = {
      choices,
      first: { count: firstCount, meanTotal: firstCount ? round3(firstSum / firstCount) : null },
      all: { rounds: classRounds, meanTotal: classRounds ? round3(classSum / classRounds) : null },
      reference: { ...REFERENCE },
    };
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
  const route = url.pathname.replace(/^\/api\/machine\/?/, '').replace(/\/+$/, '') || 'settings';

  try {
    if (req.method === 'GET') {
      if (route === 'settings') return json(await readSettings());
      if (route === 'board') {
        const limit = int(url.searchParams.get('limit'), 1, MAX_PLAYERS, 20);
        const full = url.searchParams.get('full') === '1';
        return json(await board(full, limit));
      }
      return fail('unknown route', 404);
    }

    if (req.method !== 'POST') return fail('method not allowed', 405);

    let body;
    try { body = await parseBody(req); }
    catch (err) {
      if (err.message === 'payload too large') throw err;
      return fail('the body is not valid JSON');
    }
    if (!body || typeof body !== 'object') body = {};

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
      const now = Date.now();
      await blobs.setJSON(playerKey(id), {
        id,
        token,
        name,
        joinedAt: now,
        updatedAt: now,
        live: null,
        rounds: null,
        choices: null,
        first: null,
      });
      return json({ id, token, name });
    }

    if (route === 'sync') {
      const id = String(body.id || '').replace(/[^a-z0-9]/gi, '').slice(0, 32);
      const token = String(body.token || '').slice(0, 64);
      if (!id || !token) return fail('missing identity');

      const blobs = store();
      const key = playerKey(id);
      const existing = await blobs.get(key, { type: 'json' });
      /* A wipe deleted this record. The phone joins again under the same name
       * and keeps the round it is in. */
      if (!existing) return fail('this player is no longer in the game', 409, { rejoin: true });
      if (existing.token !== token) return fail('token mismatch', 409, { rejoin: true });

      const rounds = roundsState(body.rounds);
      const record = {
        ...existing,
        updatedAt: Date.now(),
        live: liveState(body.live) || existing.live,
        /* A retried sync can arrive after a newer one, so the record with more
         * finished rounds wins. */
        rounds: rounds && (!existing.rounds || rounds.count >= existing.rounds.count)
          ? rounds : existing.rounds,
        choices: maxChoices(existing.choices, choicesState(body.choices)),
      };
      /* The first finished round is frozen once it has arrived, so a second
       * attempt cannot change the class figures. */
      if (!existing.first && body.first) {
        const first = firstRound(body.first);
        if (first) record.first = first;
      }
      await blobs.setJSON(key, record);
      return json({ ok: true });
    }

    if (route === 'admin') {
      const expected = process.env.MACHINE_ADMIN_KEY || process.env.BANDIT_ADMIN_KEY || '';
      if (expected && String(body.key || '') !== expected) return fail('bad key', 409);

      const blobs = store();
      const settings = await readSettings();

      /* A wipe deletes every player record outright, so nothing can come back
       * and a phone still playing is told to join again on its next sync.
       * The bandit dashboard calls the same thing reset, so both words work. */
      if (body.action === 'wipe' || body.action === 'reset') {
        const { blobs: entries } = await blobs.list({ prefix: PLAYER_PREFIX });
        await Promise.all(entries.map((entry) => blobs.delete(entry.key).catch(() => null)));
        cache.clear();
        return json({ ok: true, cleared: entries.length, settings });
      }

      if (body.action === 'settings') {
        const patch = body.settings && typeof body.settings === 'object' ? body.settings : {};
        const updated = {
          open: patch.open === undefined ? settings.open : patch.open !== false,
          v: SETTINGS_VERSION,
        };
        await blobs.setJSON(SETTINGS_KEY, updated);
        cache.clear();
        return json({ ok: true, settings: publicSettings(updated) });
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
