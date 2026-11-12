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
 * A draft can also have a share link, #s=<token> with 256 random bits, kept in
 * the room metadata (linkToken, linkMode). Anyone holding it can open the draft
 * without signing in, as a guest. The owner sets the link to "edit", "view" or
 * "off", and can reset it, which makes the old link stop working. Guests get a
 * Liveblocks access token for that one room, read-only when the link is "view".
 *
 * Versions. Liveblocks' own history is short on the free plan, so versions are
 * kept in Netlify Blobs: ver/<id>/<time> holds {at, by, text}. The page asks
 * for a snapshot while people edit; this function then reads the text from
 * Liveblocks itself and stores it if it changed, at most every two minutes.
 * Deleting a draft saves a last version first and keeps a record
 * (del/<id>, plus delidx/<email>/<id> for each member), so the draft can be
 * downloaded or restored later.
 *
 * Endpoints, all under /api/drafts. Those marked * need
 * "Authorization: Bearer <session token>"; the others take it if present.
 *
 *   GET    /config                         public settings for the page
 *   POST   /session          {credential}  Google ID token -> session + user
 * * GET    /me                             the signed-in user
 * * GET    /list                           drafts shared with the user
 * * POST   /create           {title}       a new draft owned by the user
 * * POST   /rename           {id, title}   any member
 * * POST   /share            {id, email}   any member adds someone
 * * POST   /unshare          {id, email}   the owner removes anyone; anyone leaves
 * * POST   /delete           {id}          the owner only
 * * POST   /members          {id}          names of the people it is shared with
 * * POST   /link             {id}          any member: the share link, created on first use
 * * POST   /link-settings    {id, mode, reset}  the owner: edit / view / off, or a new link
 * * POST   /versions         {id}          a draft's saved versions (also a deleted draft's)
 * * POST   /version          {id, key}     one version's text
 * * POST   /restore-version  {id, key}     any member: put an old version back
 * * GET    /deleted                        deleted drafts the user was a member of
 * * POST   /restore-deleted  {id}          the owner: bring a deleted draft back
 * * POST   /purge-deleted    {id}          the owner: delete a deleted draft for good
 *   POST   /snapshot         {id, linkToken?, force?}  save a version if the text changed
 *   POST   /link-open        {token}       what a share link opens
 *   POST   /liveblocks-auth  {room, linkToken?, guestId?, guestName?}
 *                                           Liveblocks' auth endpoint, for members and guests
 *
 * Environment variables:
 *   GOOGLE_CLIENT_ID          OAuth client ID of the "Sign in with Google" button
 *   LIVEBLOCKS_SECRET_KEY     sk_... from the Liveblocks project
 *   DRAFTS_SESSION_SECRET     at least 32 random characters, signs session tokens
 */
import { getStore } from '@netlify/blobs';
import { Liveblocks } from '@liveblocks/node';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import * as Y from 'yjs';

export const config = { path: ['/api/drafts', '/api/drafts/*'] };

const STORE = 'openreview-drafter';
const USER_PREFIX = 'user/';
const ROOM_PREFIX = 'ord-'; // keeps the drafter's rooms apart from any other use of the project
const SESSION_DAYS = 30;
const MAX_BODY = 16 * 1024;
const MAX_TITLE = 120;
const MAX_MEMBERS = 50;
const WRITE = ['room:write'];
const VERSION_PREFIX = 'ver/';
const VERSION_LAST = 'verlast/';
const DELETED_PREFIX = 'del/';
const DELETED_INDEX = 'delidx/';
const VERSION_MIN_GAP_MS = 2 * 60 * 1000;
const MAX_VERSIONS = 300;
const VERSION_KEY = /^ver\/ord-[A-Za-z0-9_-]{16,64}\/[0-9TZ:.-]{20,30}$/;
const LINK_MODES = ['edit', 'view', 'off'];
const DEFAULT_LINK_MODE = 'edit';
const LINK_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
const GUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

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
 * static site, so a refusal is reported as 409 instead. A 404 falls through
 * the same way, so "no such draft or link" is reported as 410. */
const fail = (message, status = 400) => json({ error: message }, status);

class Refusal extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

const GOOGLE_CLIENT_ID_SHAPE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/;

function googleClientId() {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  if (!GOOGLE_CLIENT_ID_SHAPE.test(id)) {
    if (id) console.error('drafts: GOOGLE_CLIENT_ID is not a client ID (….apps.googleusercontent.com); sign-in is off.');
    return null;
  }
  return id;
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
  if (!/^ord-[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Refusal('Unknown draft.', 410);
  return id;
}

function cleanGuestName(raw) {
  const name = String(raw || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return name ? `${name} (guest)` : 'Guest';
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
  const audience = googleClientId();
  if (!audience) throw new Refusal('Google sign-in is not set up on the server (GOOGLE_CLIENT_ID).', 500);
  let payload;
  try {
    ({ payload } = await jwtVerify(String(credential || ''), GOOGLE_JWKS, {
      issuer: GOOGLE_ISSUERS,
      audience,
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

/* The signed-in user, or null for a guest. A bad or expired token counts as
 * signed out here, so an old session doesn't stop a share link working. */
async function optionalUser(req) {
  if (!req.headers.get('authorization')) return null;
  try {
    return await requireUser(req);
  } catch (e) {
    if (e instanceof Refusal && e.status === 401) return null;
    throw e;
  }
}

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
    if (e?.status === 404) throw new Refusal('This draft no longer exists.', 410);
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

const newLinkToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
const linkMode = (room) => (LINK_MODES.includes(room.metadata?.linkMode) ? room.metadata.linkMode : DEFAULT_LINK_MODE);

async function roomForLink(token) {
  if (!LINK_TOKEN.test(String(token || ''))) throw new Refusal('This link is not valid.', 410);
  const page = await liveblocks().getRooms({ query: `metadata["linkToken"]:"${token}"`, limit: 1 });
  const room = page.data[0];
  if (!room || room.metadata?.linkToken !== token || linkMode(room) === 'off') {
    throw new Refusal('This link does not work any more. Ask for a new one.', 410);
  }
  return room;
}

/* ------------------------------------------------------------------ */
/* Versions                                                            */
/* ------------------------------------------------------------------ */

const blobs = () => getStore(STORE);
const sha256 = async (text) =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('base64url');

/* The draft's text as Liveblocks holds it right now. */
async function roomText(id) {
  const update = await liveblocks().getYjsDocumentAsBinaryUpdate(id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(update));
  return doc.getText('latex').toString();
}

/* Replace the draft's text, as one Yjs update that open pages merge in. Only
 * the part that differs is changed, so people's cursors elsewhere stay put. */
async function setRoomText(id, text) {
  const update = await liveblocks().getYjsDocumentAsBinaryUpdate(id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(update));
  const before = Y.encodeStateVector(doc);
  const ytext = doc.getText('latex');
  const old = ytext.toString();
  let p = 0;
  const max = Math.min(old.length, text.length);
  while (p < max && old[p] === text[p]) p++;
  let q = 0;
  while (q < max - p && old[old.length - 1 - q] === text[text.length - 1 - q]) q++;
  doc.transact(() => {
    if (old.length - q > p) ytext.delete(p, old.length - q - p);
    if (text.length - q > p) ytext.insert(p, text.slice(p, text.length - q));
  });
  await liveblocks().sendYjsBinaryUpdate(id, Y.encodeStateAsUpdate(doc, before));
}

/* Store the current text as a version if it changed. `force` skips the
 * two-minute spacing (used before deleting or restoring). */
async function snapshot(id, by, { force = false, note = '' } = {}) {
  const store = blobs();
  const text = await roomText(id);
  const hash = await sha256(text);
  const last = await store.get(VERSION_LAST + id, { type: 'json' });
  if (last?.hash === hash) return { saved: false, reason: 'unchanged' };
  const since = last ? Date.now() - Date.parse(last.at) : Infinity;
  if (!force && since < VERSION_MIN_GAP_MS) return { saved: false, reason: 'recent', retryIn: VERSION_MIN_GAP_MS - since };
  if (!text && !last) return { saved: false, reason: 'empty' };
  const at = new Date().toISOString();
  const key = `${VERSION_PREFIX}${id}/${at}`;
  await store.setJSON(key, { at, by, text, note });
  await store.setJSON(VERSION_LAST + id, { key, hash, at });
  await pruneVersions(id);
  return { saved: true, key };
}

async function versionKeys(id) {
  const { blobs: items } = await blobs().list({ prefix: `${VERSION_PREFIX}${id}/` });
  return items.map((b) => b.key).sort();
}

async function pruneVersions(id) {
  const keys = await versionKeys(id);
  const extra = keys.length - MAX_VERSIONS;
  for (const key of keys.slice(0, Math.max(0, extra))) await blobs().delete(key);
}

async function listVersions(id) {
  const keys = (await versionKeys(id)).reverse();
  const store = blobs();
  const items = await Promise.all(keys.map((key) => store.get(key, { type: 'json' }).then((v) => [key, v])));
  return items
    .filter(([, v]) => v)
    .map(([key, v]) => ({ key, at: v.at, by: v.by, note: v.note || '', chars: v.text.length }));
}

function cleanVersionKey(id, raw) {
  const key = String(raw || '');
  if (!VERSION_KEY.test(key) || !key.startsWith(`${VERSION_PREFIX}${id}/`)) throw new Refusal('Unknown version.', 410);
  return key;
}

async function readVersion(key) {
  const v = await blobs().get(key, { type: 'json' });
  if (!v) throw new Refusal('That version no longer exists.', 410);
  return v;
}

/* A deleted draft's record, if the user was one of its members. */
async function deletedFor(id, email) {
  const rec = await blobs().get(DELETED_PREFIX + id, { type: 'json' });
  if (!rec || !rec.members.includes(email)) throw new Refusal('This draft has not been shared with you.');
  return rec;
}

/* Access to a draft's versions: a member of the live draft, or of the
 * deleted one. Returns { room?, deleted? }. */
async function versionAccess(id, email) {
  try {
    const room = await liveblocks().getRoom(id);
    requireMember(room, email);
    return { room };
  } catch (e) {
    if (e instanceof Refusal) throw e;
    if (e?.status !== 404) throw e;
    return { deleted: await deletedFor(id, email) };
  }
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
      // Serve it only if it looks like one, so a client secret pasted into the
      // wrong variable is never published.
      if (route === 'config') return json({ googleClientId: googleClientId() });
      const user = await requireUser(req);
      if (route === 'me') return json({ user });
      if (route === 'list') return json({ drafts: await listDrafts(user.email) });
      if (route === 'deleted') {
        const { blobs: items } = await blobs().list({ prefix: `${DELETED_INDEX}${user.email}/` });
        const recs = await Promise.all(items.map((b) => blobs().get(DELETED_PREFIX + b.key.split('/').pop(), { type: 'json' })));
        return json({
          drafts: recs
            .filter(Boolean)
            .map(({ id, title, owner, deletedAt, deletedBy }) => ({ id, title, owner, deletedAt, deletedBy }))
            .sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)),
        });
      }
      return fail('unknown route', 404);
    }
    if (req.method !== 'POST') return fail('method not allowed', 405);

    const body = await parseBody(req);

    if (route === 'session') {
      const profile = await verifyGoogle(body.credential);
      const { user, isNew } = await upsertUser(profile);
      return json({ session: await issueSession(user), user, isNew });
    }

    if (route === 'link-open') {
      const room = await roomForLink(body.token);
      const user = await optionalUser(req);
      return json({
        draft: { id: room.id, title: room.metadata?.title || 'Untitled draft', owner: room.metadata?.owner || '' },
        mode: linkMode(room),
        member: Boolean(user && room.usersAccesses?.[user.email]),
      });
    }

    if (route === 'liveblocks-auth') {
      const id = cleanRoomId(body.room);
      const room = await readDraft(id);
      const user = await optionalUser(req);
      let response;
      if (user && room.usersAccesses?.[user.email]) {
        // Members: Liveblocks checks the room's own access list.
        response = await liveblocks().identifyUser(
          { userId: user.email, groupIds: [] },
          { userInfo: { name: user.name, avatar: user.picture, color: colourFor(user.email) } },
        );
      } else if (body.linkToken) {
        // Guests, and signed-in people who aren't members, through a share link.
        if (body.linkToken !== room.metadata?.linkToken || linkMode(room) === 'off') {
          throw new Refusal('This link does not work any more. Ask for a new one.');
        }
        const guestId = String(body.guestId || '');
        if (!user && !GUEST_ID.test(guestId)) throw new Refusal('Bad guest id.', 400);
        const userId = user ? user.email : `guest:${guestId}`;
        const session = liveblocks().prepareSession(userId, {
          userInfo: {
            name: user ? user.name : cleanGuestName(body.guestName),
            avatar: user?.picture || '',
            color: colourFor(userId),
          },
        });
        session.allow(id, linkMode(room) === 'edit' ? session.FULL_ACCESS : session.READ_ACCESS);
        response = await session.authorize();
      } else {
        throw new Refusal(user ? 'This draft has not been shared with you.' : 'Please sign in to open this draft.');
      }
      return new Response(response.body, {
        status: response.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }

    if (route === 'snapshot') {
      const id = cleanRoomId(body.id);
      const room = await readDraft(id);
      const user = await optionalUser(req);
      let by;
      if (user && room.usersAccesses?.[user.email]) by = user.name;
      else if (body.linkToken && body.linkToken === room.metadata?.linkToken && linkMode(room) === 'edit') {
        by = user ? user.name : cleanGuestName(body.guestName);
      } else throw new Refusal('This draft has not been shared with you.');
      return json(await snapshot(id, by, { force: Boolean(body.force) }));
    }

    const user = await requireUser(req);

    if (route === 'versions') {
      const id = cleanRoomId(body.id);
      const access = await versionAccess(id, user.email);
      return json({ versions: await listVersions(id), deleted: Boolean(access.deleted) });
    }

    if (route === 'version') {
      const id = cleanRoomId(body.id);
      await versionAccess(id, user.email);
      const v = await readVersion(cleanVersionKey(id, body.key));
      return json({ version: { at: v.at, by: v.by, text: v.text } });
    }

    if (route === 'restore-deleted' || route === 'purge-deleted') {
      const id = cleanRoomId(body.id);
      const rec = await deletedFor(id, user.email);
      if (rec.owner !== user.email) throw new Refusal('Only the owner can do this.');
      const store = blobs();
      if (route === 'restore-deleted') {
        const keys = await versionKeys(id);
        const latest = keys.length ? await readVersion(keys[keys.length - 1]) : { text: '' };
        const room = await liveblocks().createRoom(id, {
          defaultAccesses: [],
          usersAccesses: Object.fromEntries(rec.members.map((m) => [m, WRITE])),
          metadata: { title: rec.title, owner: rec.owner },
        });
        if (latest.text) await setRoomText(id, latest.text);
        await Promise.all([store.delete(DELETED_PREFIX + id), ...rec.members.map((m) => store.delete(`${DELETED_INDEX}${m}/${id}`))]);
        return json({ draft: summary(room) });
      }
      const keys = await versionKeys(id);
      await Promise.all([
        ...keys.map((k) => store.delete(k)),
        store.delete(VERSION_LAST + id),
        store.delete(DELETED_PREFIX + id),
        ...rec.members.map((m) => store.delete(`${DELETED_INDEX}${m}/${id}`)),
      ]);
      return json({ ok: true });
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
      // Keep a last version and a record, so the draft can be restored.
      await snapshot(id, user.name, { force: true, note: 'Before deleting' });
      const members = Object.keys(room.usersAccesses);
      const store = blobs();
      await store.setJSON(DELETED_PREFIX + id, {
        id,
        title: room.metadata?.title || 'Untitled draft',
        owner,
        members,
        deletedAt: new Date().toISOString(),
        deletedBy: user.name,
      });
      await Promise.all(members.map((m) => store.set(`${DELETED_INDEX}${m}/${id}`, '1')));
      await liveblocks().deleteRoom(id);
      return json({ ok: true });
    }

    if (route === 'restore-version') {
      const v = await readVersion(cleanVersionKey(id, body.key));
      await snapshot(id, user.name, { force: true, note: 'Before restoring an older version' });
      await setRoomText(id, v.text);
      await snapshot(id, user.name, { force: true, note: `Restored the version from ${v.at}` });
      return json({ ok: true });
    }

    if (route === 'link') {
      let token = room.metadata?.linkToken;
      let mode = linkMode(room);
      if (!token) {
        token = newLinkToken();
        mode = DEFAULT_LINK_MODE;
        await liveblocks().updateRoom(id, { metadata: { linkToken: token, linkMode: mode } });
      }
      return json({ token, mode, canManage: user.email === owner });
    }

    if (route === 'link-settings') {
      if (user.email !== owner) throw new Refusal('Only the owner can change the share link.');
      const mode = body.mode === undefined ? linkMode(room) : String(body.mode);
      if (!LINK_MODES.includes(mode)) throw new Refusal('Unknown link setting.', 400);
      const token = body.reset || !room.metadata?.linkToken ? newLinkToken() : room.metadata.linkToken;
      await liveblocks().updateRoom(id, { metadata: { linkToken: token, linkMode: mode } });
      return json({ token, mode, canManage: true });
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
