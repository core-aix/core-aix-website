/**
 * Accounts, sharing and live-editing access for the OpenReview Drafter
 * (static/openreview-drafter/).
 *
 * People sign in with Google. The page sends the Google ID token here once;
 * this function checks it and answers with a session token of its own, valid
 * for 30 days, which the page keeps in the browser's local storage. The first
 * sign-in creates the account record.
 *
 * Each draft is a Liveblocks room. The text itself never passes through this
 * function: browsers edit it together through Liveblocks. Liveblocks also
 * stores who may open each room (its users accesses) and the draft's title and
 * owner (its metadata), so there is no second copy of the sharing list here to
 * drift out of step.
 *
 * Endpoints, all under /api/drafts, all but /session needing
 * "Authorization: Bearer <session token>":
 *
 *   GET    /config                         public settings for the page
 *   POST   /session          {credential}  Google ID token -> session + user
 *   GET    /me                             the signed-in user
 *   GET    /list                           drafts shared with the user
 *   POST   /create           {title}       a new draft owned by the user
 *   POST   /rename           {id, title}   any member
 *   POST   /share            {id, email}   any member adds someone
 *   POST   /unshare          {id, email}   the owner removes anyone; anyone leaves
 *   POST   /delete           {id}          the owner only
 *   POST   /members          {id}          names of the people it is shared with
 *   POST   /liveblocks-auth  {room}        Liveblocks' auth endpoint
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID          OAuth client ID of the "Sign in with Google" button
 *   LIVEBLOCKS_SECRET_KEY     sk_... from the Liveblocks project
 *   DRAFTS_SESSION_SECRET     at least 32 random characters, signs session tokens
 */
import { getStore } from '@netlify/blobs';
import { Liveblocks } from '@liveblocks/node';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

export const config = { path: ['/api/drafts', '/api/drafts/*'] };

const STORE = 'openreview-drafter';
const USER_PREFIX = 'user/';
const ROOM_PREFIX = 'ord-'; // keeps the drafter's rooms apart from any other use of the project
const SESSION_DAYS = 30;
const MAX_BODY = 16 * 1024;
const MAX_TITLE = 120;
const MAX_MEMBERS = 50;
const WRITE = ['room:write'];

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

/* Cursor colours, picked from the e-mail address so a person keeps theirs. */
const COLOURS = ['#d0342c', '#1f6feb', '#2e7d32', '#8e44ad', '#e67e22', '#00838f', '#c2185b', '#5d4037'];

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* Netlify turns a 403 from a function into a 404 and falls through to the
 * static site, so a refusal is reported as 409 instead. */
const fail = (message, status = 400) => json({ error: message }, status);

class Refusal extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function env(name) {
  const value = process.env[name];
  if (!value) throw new Refusal(`The server is missing ${name}.`, 500);
  return value;
}

const sessionKey = () => {
  const secret = env('DRAFTS_SESSION_SECRET');
  if (secret.length < 32) throw new Refusal('DRAFTS_SESSION_SECRET must be at least 32 characters.', 500);
  return new TextEncoder().encode(secret);
};

let liveblocksClient;
const liveblocks = () => (liveblocksClient ??= new Liveblocks({ secret: env('LIVEBLOCKS_SECRET_KEY') }));

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) throw new Refusal('That is not a valid e-mail address.', 400);
  return email;
}

function cleanTitle(raw) {
  const title = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE);
  return title || 'Untitled draft';
}

function cleanRoomId(raw) {
  const id = String(raw || '');
  if (!/^ord-[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Refusal('Unknown draft.', 404);
  return id;
}

async function parseBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Refusal('Request too large.', 413);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Refusal('Request is not valid JSON.', 400);
  }
}

const colourFor = (email) => {
  let h = 0;
  for (const ch of email) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLOURS[h % COLOURS.length];
};

/* ------------------------------------------------------------------ */
/* Accounts and sessions                                               */
/* ------------------------------------------------------------------ */

async function verifyGoogle(credential) {
  let payload;
  try {
    ({ payload } = await jwtVerify(String(credential || ''), GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience: env('GOOGLE_CLIENT_ID'),
    }));
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('Google sign-in could not be verified. Please try again.', 401);
  }
  if (!payload.email || payload.email_verified !== true) {
    throw new Refusal('Your Google account has no verified e-mail address.', 401);
  }
  return {
    email: String(payload.email).toLowerCase(),
    name: String(payload.name || payload.email).slice(0, 80),
    picture: typeof payload.picture === 'string' ? payload.picture : '',
  };
}

/* The account record. Created on the first sign-in and refreshed on each one,
 * so a collaborator's name shows up in the sharing list. */
async function upsertUser(profile) {
  const store = getStore(STORE);
  const key = USER_PREFIX + profile.email;
  const existing = await store.get(key, { type: 'json' });
  const now = new Date().toISOString();
  const user = { ...profile, createdAt: existing?.createdAt || now, lastSignIn: now };
  await store.setJSON(key, user);
  return { user, isNew: !existing };
}

async function readUsers(emails) {
  const store = getStore(STORE);
  const users = await Promise.all(emails.map((e) => store.get(USER_PREFIX + e, { type: 'json' }).catch(() => null)));
  return Object.fromEntries(emails.map((e, i) => [e, users[i] ? { name: users[i].name, picture: users[i].picture } : null]));
}

const issueSession = (user) =>
  new SignJWT({ name: user.name, picture: user.picture })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.email)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_DAYS}d`)
    .sign(sessionKey());

async function requireUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!m) throw new Refusal('Please sign in.', 401);
  try {
    const { payload } = await jwtVerify(m[1], sessionKey(), { algorithms: ['HS256'] });
    return { email: payload.sub, name: payload.name, picture: payload.picture };
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('Your session has expired. Please sign in again.', 401);
  }
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

async function readDraft(id) {
  try {
    return await liveblocks().getRoom(id);
  } catch (e) {
    if (e?.status === 404) throw new Refusal('This draft no longer exists.', 404);
    throw e;
  }
}

/* Rooms carry their own access list; being in it is what membership means. */
function requireMember(room, email) {
  if (!room.usersAccesses?.[email]) throw new Refusal('This draft has not been shared with you.');
}

function summary(room) {
  return {
    id: room.id,
    title: room.metadata?.title || 'Untitled draft',
    owner: room.metadata?.owner || '',
    members: Object.keys(room.usersAccesses || {}).sort(),
    createdAt: room.createdAt,
    lastConnectionAt: room.lastConnectionAt || null,
  };
}

function newRoomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return ROOM_PREFIX + Buffer.from(bytes).toString('base64url');
}

async function listDrafts(email) {
  const drafts = [];
  let cursor;
  do {
    const page = await liveblocks().getRooms({
      userId: email,
      query: `roomId^"${ROOM_PREFIX}"`,
      limit: 100,
      ...(cursor ? { startingAfter: cursor } : {}),
    });
    for (const room of page.data) if (room.usersAccesses?.[email]) drafts.push(summary(room));
    cursor = page.nextCursor;
  } while (cursor && drafts.length < 500);
  return drafts;
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

export default async function handler(req) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/drafts\/?/, '').replace(/\/+$/, '');

  try {
    if (req.method === 'GET') {
      // The Google client ID is public; serving it keeps it in one place.
      if (route === 'config') return json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
      const user = await requireUser(req);
      if (route === 'me') return json({ user });
      if (route === 'list') return json({ drafts: await listDrafts(user.email) });
      return fail('unknown route', 404);
    }
    if (req.method !== 'POST') return fail('method not allowed', 405);

    const body = await parseBody(req);

    if (route === 'session') {
      const profile = await verifyGoogle(body.credential);
      const { user, isNew } = await upsertUser(profile);
      return json({ session: await issueSession(user), user, isNew });
    }

    const user = await requireUser(req);

    if (route === 'liveblocks-auth') {
      const id = cleanRoomId(body.room);
      requireMember(await readDraft(id), user.email);
      const { status, body: lbBody } = await liveblocks().identifyUser(
        { userId: user.email, groupIds: [] },
        { userInfo: { name: user.name, avatar: user.picture, color: colourFor(user.email) } },
      );
      return new Response(lbBody, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }

    if (route === 'create') {
      const id = newRoomId();
      const room = await liveblocks().createRoom(id, {
        defaultAccesses: [],
        usersAccesses: { [user.email]: WRITE },
        metadata: { title: cleanTitle(body.title), owner: user.email },
      });
      return json({ draft: summary(room) });
    }

    const id = cleanRoomId(body.id);
    const room = await readDraft(id);
    requireMember(room, user.email);
    const owner = room.metadata?.owner;

    if (route === 'rename') {
      const updated = await liveblocks().updateRoom(id, { metadata: { title: cleanTitle(body.title) } });
      return json({ draft: summary(updated) });
    }

    if (route === 'share') {
      const email = cleanEmail(body.email);
      if (!room.usersAccesses[email] && Object.keys(room.usersAccesses).length >= MAX_MEMBERS) {
        throw new Refusal(`A draft can be shared with at most ${MAX_MEMBERS} people.`);
      }
      const updated = await liveblocks().updateRoom(id, { usersAccesses: { [email]: WRITE } });
      return json({ draft: summary(updated) });
    }

    if (route === 'unshare') {
      const email = cleanEmail(body.email);
      if (email === owner) throw new Refusal('The owner cannot be removed. Delete the draft instead.');
      if (email !== user.email && user.email !== owner) throw new Refusal('Only the owner can remove other people.');
      const updated = await liveblocks().updateRoom(id, { usersAccesses: { [email]: null } });
      return json({ draft: summary(updated) });
    }

    if (route === 'delete') {
      if (user.email !== owner) throw new Refusal('Only the owner can delete this draft.');
      await liveblocks().deleteRoom(id);
      return json({ ok: true });
    }

    if (route === 'members') {
      const members = Object.keys(room.usersAccesses).sort();
      return json({ members: await readUsers(members), owner });
    }

    return fail('unknown route', 404);
  } catch (e) {
    if (e instanceof Refusal) return fail(e.message, e.status);
    console.error('drafts:', e);
    return fail('Something went wrong on the server. Please try again.', 500);
  }
}
